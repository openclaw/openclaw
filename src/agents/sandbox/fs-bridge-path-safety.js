import fs from "node:fs";
import path from "node:path";
import { openBoundaryFile } from "./fs-bridge-path-safety.runtime.js";
import { isPathInsideContainerRoot, normalizeContainerPath } from "./path-utils.js";
export class SandboxFsPathGuard {
    mountsByContainer;
    runCommand;
    constructor(params) {
        this.mountsByContainer = params.mountsByContainer;
        this.runCommand = params.runCommand;
    }
    async assertPathChecks(checks) {
        for (const check of checks) {
            await this.assertPathSafety(check.target, check.options);
        }
    }
    async assertPathSafety(target, options) {
        const guarded = await this.openBoundaryWithinRequiredMount(target, options.action, {
            aliasPolicy: options.aliasPolicy,
            allowedType: options.allowedType,
        });
        await this.assertGuardedPathSafety(target, options, guarded);
    }
    async openReadableFile(target) {
        const opened = await this.openBoundaryWithinRequiredMount(target, "read files");
        if (!opened.ok) {
            throw opened.error instanceof Error
                ? opened.error
                : new Error(`Sandbox boundary checks failed; cannot read files: ${target.containerPath}`);
        }
        return opened;
    }
    resolveRequiredMount(containerPath, action) {
        const lexicalMount = this.resolveMountByContainerPath(containerPath);
        if (!lexicalMount) {
            throw new Error(`Sandbox path escapes allowed mounts; cannot ${action}: ${containerPath}`);
        }
        return lexicalMount;
    }
    finalizePinnedEntry(params) {
        const relativeParentPath = path.posix.relative(params.mount.containerRoot, params.parentPath);
        if (relativeParentPath.startsWith("..") || path.posix.isAbsolute(relativeParentPath)) {
            throw new Error(`Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.targetPath}`);
        }
        return {
            mountRootPath: params.mount.containerRoot,
            relativeParentPath: relativeParentPath === "." ? "" : relativeParentPath,
            basename: params.basename,
        };
    }
    async assertGuardedPathSafety(target, options, guarded) {
        if (!guarded.ok) {
            if (guarded.reason !== "path") {
                const canFallbackToDirectoryStat = options.allowedType === "directory" && this.pathIsExistingDirectory(target.hostPath);
                if (!canFallbackToDirectoryStat) {
                    throw guarded.error instanceof Error
                        ? guarded.error
                        : new Error(`Sandbox boundary checks failed; cannot ${options.action}: ${target.containerPath}`);
                }
            }
        }
        else {
            fs.closeSync(guarded.fd);
        }
        const canonicalContainerPath = await this.resolveCanonicalContainerPath({
            containerPath: target.containerPath,
            allowFinalSymlinkForUnlink: options.aliasPolicy?.allowFinalSymlinkForUnlink === true,
        });
        const canonicalMount = this.resolveRequiredMount(canonicalContainerPath, options.action);
        if (options.requireWritable && !canonicalMount.writable) {
            throw new Error(`Sandbox path is read-only; cannot ${options.action}: ${target.containerPath}`);
        }
    }
    async openBoundaryWithinRequiredMount(target, action, options) {
        const lexicalMount = this.resolveRequiredMount(target.containerPath, action);
        const guarded = await openBoundaryFile({
            absolutePath: target.hostPath,
            rootPath: lexicalMount.hostRoot,
            boundaryLabel: "sandbox mount root",
            aliasPolicy: options?.aliasPolicy,
            allowedType: options?.allowedType,
        });
        return guarded;
    }
    resolvePinnedEntry(target, action) {
        const basename = path.posix.basename(target.containerPath);
        if (!basename || basename === "." || basename === "/") {
            throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
        }
        const parentPath = normalizeContainerPath(path.posix.dirname(target.containerPath));
        const mount = this.resolveRequiredMount(parentPath, action);
        return this.finalizePinnedEntry({
            mount,
            parentPath,
            basename,
            targetPath: target.containerPath,
            action,
        });
    }
    async resolveAnchoredSandboxEntry(target, action) {
        const basename = path.posix.basename(target.containerPath);
        if (!basename || basename === "." || basename === "/") {
            throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
        }
        const parentPath = normalizeContainerPath(path.posix.dirname(target.containerPath));
        const canonicalParentPath = await this.resolveCanonicalContainerPath({
            containerPath: parentPath,
            allowFinalSymlinkForUnlink: false,
        });
        this.resolveRequiredMount(canonicalParentPath, action);
        return {
            canonicalParentPath,
            basename,
        };
    }
    async resolveAnchoredPinnedEntry(target, action) {
        const anchoredTarget = await this.resolveAnchoredSandboxEntry(target, action);
        const mount = this.resolveRequiredMount(anchoredTarget.canonicalParentPath, action);
        return this.finalizePinnedEntry({
            mount,
            parentPath: anchoredTarget.canonicalParentPath,
            basename: anchoredTarget.basename,
            targetPath: target.containerPath,
            action,
        });
    }
    resolvePinnedDirectoryEntry(target, action) {
        const mount = this.resolveRequiredMount(target.containerPath, action);
        const relativePath = path.posix.relative(mount.containerRoot, target.containerPath);
        if (relativePath.startsWith("..") || path.posix.isAbsolute(relativePath)) {
            throw new Error(`Sandbox path escapes allowed mounts; cannot ${action}: ${target.containerPath}`);
        }
        return {
            mountRootPath: mount.containerRoot,
            relativePath: relativePath === "." ? "" : relativePath,
        };
    }
    pathIsExistingDirectory(hostPath) {
        try {
            return fs.statSync(hostPath).isDirectory();
        }
        catch {
            return false;
        }
    }
    resolveMountByContainerPath(containerPath) {
        const normalized = normalizeContainerPath(containerPath);
        for (const mount of this.mountsByContainer) {
            if (isPathInsideContainerRoot(normalizeContainerPath(mount.containerRoot), normalized)) {
                return mount;
            }
        }
        return null;
    }
    async resolveCanonicalContainerPath(params) {
        const script = [
            "set -eu",
            'target="$1"',
            'allow_final="$2"',
            'suffix=""',
            'probe="$target"',
            'if [ "$allow_final" = "1" ] && [ -L "$target" ]; then probe=$(dirname -- "$target"); fi',
            'cursor="$probe"',
            'while [ ! -e "$cursor" ] && [ ! -L "$cursor" ]; do',
            '  parent=$(dirname -- "$cursor")',
            '  if [ "$parent" = "$cursor" ]; then break; fi',
            '  base=$(basename -- "$cursor")',
            '  suffix="/$base$suffix"',
            '  cursor="$parent"',
            "done",
            'canonical=$(readlink -f -- "$cursor")',
            'printf "%s%s\\n" "$canonical" "$suffix"',
        ].join("\n");
        const result = await this.runCommand(script, {
            args: [params.containerPath, params.allowFinalSymlinkForUnlink ? "1" : "0"],
        });
        const canonical = result.stdout.toString("utf8").trim();
        if (!canonical.startsWith("/")) {
            throw new Error(`Failed to resolve canonical sandbox path: ${params.containerPath}`);
        }
        return normalizeContainerPath(canonical);
    }
}
