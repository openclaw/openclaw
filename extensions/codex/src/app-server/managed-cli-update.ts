import fsSync from "node:fs";
/** Stable CLI acquisition uses the same npm and selection owners as plugin maintenance. */
import fs from "node:fs/promises";
import path from "node:path";
import { sha256FileSync } from "@openclaw/fs-safe/durability";
import { extractArchive } from "openclaw/plugin-sdk/archive";
import {
  installFromValidatedNpmSpecArchive,
  installPackageDir,
  resolveNpmSpecMetadata,
} from "openclaw/plugin-sdk/package-install-runtime";
import {
  commandProcessCleanup,
  withCommandProcessScope,
} from "openclaw/plugin-sdk/process-runtime";
import { assertNoSymlinkParents } from "openclaw/plugin-sdk/security-runtime";
import { gt, valid } from "semver";
import {
  directoryIdentityIsStable,
  readRealDirectoryIdentity,
  assertDirectoryIdentityStable,
} from "./computer-use-service-path.js";
import {
  observeCodexManagedRuntimeSelection,
  publishCodexManagedRuntimeSelection,
  readCodexManagedRuntimeSelection,
  resolveCodexManagedRuntimeRoot,
  type CodexManagedRuntimeSelection,
  type CodexManagedRuntimeStateOptions,
} from "./managed-runtime-installation.js";
import { CODEX_APP_SERVER_VERSION, MANAGED_CODEX_APP_SERVER_PACKAGE } from "./version.js";

export async function updateCodexManagedCli(
  params: CodexManagedRuntimeStateOptions & {
    root?: string;
    signal: AbortSignal;
    assertCurrent: () => void;
    validateCandidate: (command: string, version: string) => Promise<void>;
  },
): Promise<{
  status: "updated" | "current";
  version: string;
  command?: string;
  warnings?: string[];
}> {
  let retain = false;
  let cleanup: (() => Promise<void>) | undefined;
  let cleanupAcquisition: (() => Promise<void>) | undefined;
  try {
    const result = await withCommandProcessScope(async () => {
      const assertCurrent = () => {
        params.signal.throwIfAborted();
        params.assertCurrent();
      };
      assertCurrent();
      const root = path.resolve(params.root ?? resolveCodexManagedRuntimeRoot("cli"));
      const observation = await observeCodexManagedRuntimeSelection({ ...params, root });
      const previous = observation.installation;
      const oldVersion = previous?.selection.runtimeVersion ?? CODEX_APP_SERVER_VERSION;
      const metadata = await resolveNpmSpecMetadata({
        spec: `${MANAGED_CODEX_APP_SERVER_PACKAGE}@latest`,
        signal: params.signal,
      });
      assertCurrent();
      if (!metadata.ok) {
        throw new Error(metadata.error);
      }
      const { version, name, integrity } = metadata.metadata;
      if (
        name !== MANAGED_CODEX_APP_SERVER_PACKAGE ||
        !version ||
        !/^\d+\.\d+\.\d+$/u.test(version) ||
        !valid(version) ||
        !integrity
      ) {
        throw new Error("Official stable Codex metadata is missing a stable version or integrity.");
      }
      if (!gt(version, oldVersion)) {
        return { status: "current" as const, version: oldVersion };
      }
      const versions = path.join(root, "versions");
      await assertNoSymlinkParents({
        rootDir: path.parse(root).root,
        targetPath: versions,
        allowMissing: true,
        requireDirectories: true,
      });
      assertCurrent();
      await fs.mkdir(versions, { recursive: true, mode: 0o700 });
      const rootIdentity = await readRealDirectoryIdentity(root, "Codex CLI root");
      const versionsIdentity = await readRealDirectoryIdentity(versions, "Codex CLI versions");
      const generation = await fs.mkdtemp(path.join(versions, `${version}-`));
      const generationIdentity = await readRealDirectoryIdentity(
        generation,
        "Codex CLI generation",
      );
      const target = path.join(generation, "cli");
      const command = path.join(target, "bin", "codex.js");
      const selection: CodexManagedRuntimeSelection = {
        version: 1,
        appName: "cli",
        generation: path.basename(generation),
        runtimeVersion: version,
      };
      const acquisition = path.join(generation, "acquisition");
      await fs.mkdir(acquisition, { mode: 0o700 });
      const canRemove = async () =>
        (await directoryIdentityIsStable(rootIdentity)) &&
        (await directoryIdentityIsStable(versionsIdentity)) &&
        (await directoryIdentityIsStable(generationIdentity));
      cleanup = async () => {
        if (await canRemove()) {
          await fs.rm(generation, { recursive: true, force: true });
        }
      };
      cleanupAcquisition = async () => {
        if (await canRemove()) {
          await fs.rm(acquisition, { recursive: true, force: true });
        }
      };
      let publicationAttempted = false;
      try {
        const acquisitionResult = await withCommandProcessScope(
          () =>
            installFromValidatedNpmSpecArchive({
              spec: `${MANAGED_CODEX_APP_SERVER_PACKAGE}@${version}`,
              expectedIntegrity: integrity,
              timeoutMs: 600_000,
              tempDirPrefix: "codex-runtime-package-",
              workspaceDir: acquisition,
              archiveInstallParams: {},
              installFromArchive: async ({ archivePath }: { archivePath: string }) => {
                assertCurrent();
                const source = path.join(path.dirname(archivePath), "source");
                await fs.mkdir(source, { mode: 0o700 });
                await extractArchive({
                  archivePath,
                  destDir: source,
                  stripComponents: 1,
                  timeoutMs: 600_000,
                  durable: false,
                });
                assertCurrent();
                return await installPackageDir({
                  sourceDir: source,
                  targetDir: target,
                  mode: "install",
                  timeoutMs: 600_000,
                  hasDeps: true,
                  copyErrorPrefix: "Codex CLI acquisition failed",
                  depsLogMessage: "Installing official Codex platform runtime",
                  beforePersistentApply: assertCurrent,
                });
              },
            }),
          params.signal,
        );
        if (!acquisitionResult.ok) {
          throw new Error(acquisitionResult.error);
        }
        assertCurrent();
        const assertFilesCurrent = captureRuntimeFiles(target);
        await params.validateCandidate(command, version);
        assertFilesCurrent();
        await assertDirectoryIdentityStable(rootIdentity, "Codex CLI root");
        await assertDirectoryIdentityStable(versionsIdentity, "Codex CLI versions");
        await assertDirectoryIdentityStable(generationIdentity, "Codex CLI generation");
        assertCurrent();
        publicationAttempted = true;
        await publishCodexManagedRuntimeSelection({
          ...params,
          root,
          selection,
          assertCurrent: () => {
            assertCurrent();
            assertFilesCurrent();
          },
          expectedComparison: observation.comparison,
        });
        retain = true;
        return { status: "updated" as const, version, command };
      } catch (error) {
        // Any publication may have admitted a client, even if an acknowledgement was lost.
        retain = publicationAttempted || commandProcessCleanup.isUncertain(error);
        if (publicationAttempted && !commandProcessCleanup.isUncertain(error)) {
          const current = await readCodexManagedRuntimeSelection(root, params).catch(
            () => undefined,
          );
          if (current?.selection.generation === selection.generation) {
            return {
              status: "updated" as const,
              version,
              command,
              warnings: [
                "Codex CLI selected; publication acknowledgement failed. Previous generations retained.",
              ],
            };
          }
        }
        throw error;
      }
    }, params.signal);
    try {
      await cleanupAcquisition?.();
    } catch (error) {
      if (result.status !== "updated") {
        throw error;
      }
      return {
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          "Codex CLI selected; acquisition scratch cleanup failed. Previous generations retained.",
        ],
      };
    }
    return result;
  } catch (error) {
    retain ||= commandProcessCleanup.isUncertain(error);
    throw error;
  } finally {
    // The command scope has settled before any acquired files can be removed.
    if (!retain) {
      await cleanup?.();
    }
  }
}

/** Revalidate the launcher and every platform dependency, not just the containing directory. */
function captureRuntimeFiles(root: string): () => void {
  const files = new Map<string, string>();
  const identity = (file: string) => {
    const stat = fsSync.lstatSync(file, { bigint: true });
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error("Codex runtime contains an unsupported filesystem entry.");
    }
    if (stat.isSymbolicLink()) {
      const relative = path.relative(root, fsSync.realpathSync(file));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Codex runtime dependency escapes its immutable generation.");
      }
    }
    if (!stat.isSymbolicLink() && process.platform !== "win32" && stat.mode & 0o022n) {
      throw new Error("Codex runtime files must not be shared-writable.");
    }
    if (process.getuid && stat.uid !== BigInt(process.getuid())) {
      throw new Error("Codex runtime files must be owned by this user.");
    }
    // Timestamp resolution can hide same-size writes; bind qualification to bytes and entries.
    const content = stat.isFile()
      ? sha256FileSync(file).digest
      : stat.isDirectory()
        ? JSON.stringify(fsSync.readdirSync(file).toSorted())
        : fsSync.readlinkSync(file);
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, content].join(
      ":",
    );
  };
  const visit = (file: string) => {
    files.set(file, identity(file));
    if (fsSync.lstatSync(file).isDirectory()) {
      for (const child of fsSync.readdirSync(file)) {
        visit(path.join(file, child));
      }
    }
  };
  visit(root);
  return () => {
    for (const [file, before] of files) {
      if (identity(file) !== before) {
        throw new Error("Codex runtime files changed during qualification or selection.");
      }
    }
  };
}
