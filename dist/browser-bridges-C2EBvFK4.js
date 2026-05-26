import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { c as PATH_ALIAS_POLICIES } from "./secure-temp-dir-aidxCRgA.js";
import { r as resolveRootPath } from "./root-path-BgCKz8X4.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./path-guards-CBe_wA_B.js";
import "./boundary-path-CBe_wA_B.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import "./sandbox-paths-BTYunIeX.js";
import { n as loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime-D0XwEzEs.js";
import { i as resolveSandboxConfigForAgent } from "./config-CcQ2HijN.js";
import { t as buildDockerExecArgs } from "./bash-tools.shared-DwMDKMvR.js";
import { t as sanitizeEnvVars } from "./sanitize-env-vars-4wyDg6L9.js";
import { a as execDocker, i as ensureSandboxContainer, n as dockerContainerState, o as execDockerRaw } from "./docker-DfzYD6UD.js";
import { t as parseSshTarget } from "./ssh-tunnel-BIb8VLdL.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
//#region src/agents/sandbox/docker-backend.ts
function resolveConfiguredDockerRuntimeImage(params) {
	const sandboxCfg = resolveSandboxConfigForAgent(params.config, params.agentId);
	switch (params.configLabelKind) {
		case "BrowserImage": return sandboxCfg.browser.image;
		case "Image":
		case void 0:
		default: return sandboxCfg.docker.image;
	}
}
async function createDockerSandboxBackend(params) {
	return createDockerSandboxBackendHandle({
		containerName: await ensureSandboxContainer({
			sessionKey: params.sessionKey,
			workspaceDir: params.workspaceDir,
			agentWorkspaceDir: params.agentWorkspaceDir,
			cfg: params.cfg
		}),
		workdir: params.cfg.docker.workdir,
		env: params.cfg.docker.env,
		image: params.cfg.docker.image
	});
}
function createDockerSandboxBackendHandle(params) {
	return {
		id: "docker",
		runtimeId: params.containerName,
		runtimeLabel: params.containerName,
		workdir: params.workdir,
		env: params.env,
		configLabel: params.image,
		configLabelKind: "Image",
		capabilities: { browser: true },
		async buildExecSpec({ command, workdir, env, usePty }) {
			return {
				argv: ["docker", ...buildDockerExecArgs({
					containerName: params.containerName,
					command,
					workdir: workdir ?? params.workdir,
					env,
					tty: usePty
				})],
				env: process.env,
				stdinMode: usePty ? "pipe-open" : "pipe-closed"
			};
		},
		runShellCommand(command) {
			return runDockerSandboxShellCommand({
				containerName: params.containerName,
				...command
			});
		}
	};
}
function runDockerSandboxShellCommand(params) {
	const dockerArgs = [
		"exec",
		"-i",
		params.containerName,
		"sh",
		"-c",
		params.script,
		"openclaw-sandbox-fs"
	];
	if (params.args?.length) dockerArgs.push(...params.args);
	return execDockerRaw(dockerArgs, {
		input: params.stdin,
		allowFailure: params.allowFailure,
		signal: params.signal
	});
}
const dockerSandboxBackendManager = {
	async describeRuntime({ entry, config, agentId }) {
		const state = await dockerContainerState(entry.containerName);
		let actualConfigLabel = entry.image;
		if (state.exists) try {
			const result = await execDocker([
				"inspect",
				"-f",
				"{{.Config.Image}}",
				entry.containerName
			], { allowFailure: true });
			if (result.code === 0) actualConfigLabel = result.stdout.trim() || actualConfigLabel;
		} catch {}
		const configuredImage = resolveConfiguredDockerRuntimeImage({
			config,
			agentId,
			configLabelKind: entry.configLabelKind
		});
		return {
			running: state.running,
			actualConfigLabel,
			configLabelMatch: actualConfigLabel === configuredImage
		};
	},
	async removeRuntime({ entry }) {
		const result = await execDocker([
			"rm",
			"-f",
			entry.containerName
		], { allowFailure: true });
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
			if (/No such (container|object)/iu.test(detail)) return;
			throw new Error(`Failed to remove Docker sandbox runtime ${entry.containerName}: ${detail}`);
		}
	}
};
//#endregion
//#region src/agents/sandbox/fs-bridge-mutation-helper.ts
const SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES = [
	"/usr/bin/python3",
	"/usr/local/bin/python3",
	"/opt/homebrew/bin/python3",
	"/bin/python3"
];
const SANDBOX_PINNED_MUTATION_PYTHON = [
	"import errno",
	"import os",
	"import secrets",
	"import stat",
	"import sys",
	"",
	"operation = sys.argv[1]",
	"",
	"DIR_FLAGS = os.O_RDONLY",
	"if hasattr(os, 'O_DIRECTORY'):",
	"    DIR_FLAGS |= os.O_DIRECTORY",
	"if hasattr(os, 'O_NOFOLLOW'):",
	"    DIR_FLAGS |= os.O_NOFOLLOW",
	"",
	"READ_FLAGS = os.O_RDONLY",
	"if hasattr(os, 'O_NOFOLLOW'):",
	"    READ_FLAGS |= os.O_NOFOLLOW",
	"",
	"WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL",
	"if hasattr(os, 'O_NOFOLLOW'):",
	"    WRITE_FLAGS |= os.O_NOFOLLOW",
	"",
	"def split_relative(path_value):",
	"    segments = []",
	"    for segment in path_value.split('/'):",
	"        if not segment or segment == '.':",
	"            continue",
	"        if segment == '..':",
	"            raise OSError(errno.EPERM, 'path traversal is not allowed', segment)",
	"        segments.append(segment)",
	"    return segments",
	"",
	"def open_dir(path_value, dir_fd=None):",
	"    return os.open(path_value, DIR_FLAGS, dir_fd=dir_fd)",
	"",
	"def walk_dir(root_fd, rel_path, mkdir_enabled):",
	"    current_fd = os.dup(root_fd)",
	"    try:",
	"        for segment in split_relative(rel_path):",
	"            try:",
	"                next_fd = open_dir(segment, dir_fd=current_fd)",
	"            except FileNotFoundError:",
	"                if not mkdir_enabled:",
	"                    raise",
	"                os.mkdir(segment, 0o777, dir_fd=current_fd)",
	"                next_fd = open_dir(segment, dir_fd=current_fd)",
	"            os.close(current_fd)",
	"            current_fd = next_fd",
	"        return current_fd",
	"    except Exception:",
	"        os.close(current_fd)",
	"        raise",
	"",
	"def create_temp_file(parent_fd, basename):",
	"    prefix = '.openclaw-write-' + basename + '.'",
	"    for _ in range(128):",
	"        candidate = prefix + secrets.token_hex(6)",
	"        try:",
	"            fd = os.open(candidate, WRITE_FLAGS, 0o600, dir_fd=parent_fd)",
	"            return candidate, fd",
	"        except FileExistsError:",
	"            continue",
	"    raise RuntimeError('failed to allocate sandbox temp file')",
	"",
	"def create_temp_dir(parent_fd, basename, mode):",
	"    prefix = '.openclaw-move-' + basename + '.'",
	"    for _ in range(128):",
	"        candidate = prefix + secrets.token_hex(6)",
	"        try:",
	"            os.mkdir(candidate, mode, dir_fd=parent_fd)",
	"            return candidate",
	"        except FileExistsError:",
	"            continue",
	"    raise RuntimeError('failed to allocate sandbox temp directory')",
	"",
	"def existing_regular_file_mode(parent_fd, basename):",
	"    try:",
	"        target_stat = os.lstat(basename, dir_fd=parent_fd)",
	"    except FileNotFoundError:",
	"        return None",
	"    if stat.S_ISREG(target_stat.st_mode):",
	"        return stat.S_IMODE(target_stat.st_mode)",
	"    return None",
	"",
	"def write_atomic(parent_fd, basename, stdin_buffer):",
	"    target_mode = existing_regular_file_mode(parent_fd, basename)",
	"    temp_fd = None",
	"    temp_name = None",
	"    try:",
	"        temp_name, temp_fd = create_temp_file(parent_fd, basename)",
	"        while True:",
	"            chunk = stdin_buffer.read(65536)",
	"            if not chunk:",
	"                break",
	"            os.write(temp_fd, chunk)",
	"        if target_mode is not None:",
	"            try:",
	"                os.fchmod(temp_fd, target_mode)",
	"            except AttributeError:",
	"                pass",
	"        os.fsync(temp_fd)",
	"        os.close(temp_fd)",
	"        temp_fd = None",
	"        os.replace(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)",
	"        temp_name = None",
	"        os.fsync(parent_fd)",
	"    finally:",
	"        if temp_fd is not None:",
	"            os.close(temp_fd)",
	"        if temp_name is not None:",
	"            try:",
	"                os.unlink(temp_name, dir_fd=parent_fd)",
	"            except FileNotFoundError:",
	"                pass",
	"",
	"def read_file(parent_fd, basename):",
	"    file_fd = os.open(basename, READ_FLAGS, dir_fd=parent_fd)",
	"    try:",
	"        file_stat = os.fstat(file_fd)",
	"        if not stat.S_ISREG(file_stat.st_mode):",
	"            raise OSError(errno.EPERM, 'only regular files are allowed', basename)",
	"        if file_stat.st_nlink > 1:",
	"            raise OSError(errno.EPERM, 'hardlinked file is not allowed', basename)",
	"        while True:",
	"            chunk = os.read(file_fd, 65536)",
	"            if not chunk:",
	"                break",
	"            os.write(1, chunk)",
	"    finally:",
	"        os.close(file_fd)",
	"",
	"def remove_tree(parent_fd, basename):",
	"    entry_stat = os.lstat(basename, dir_fd=parent_fd)",
	"    if not stat.S_ISDIR(entry_stat.st_mode) or stat.S_ISLNK(entry_stat.st_mode):",
	"        os.unlink(basename, dir_fd=parent_fd)",
	"        return",
	"    dir_fd = open_dir(basename, dir_fd=parent_fd)",
	"    try:",
	"        for child in os.listdir(dir_fd):",
	"            remove_tree(dir_fd, child)",
	"    finally:",
	"        os.close(dir_fd)",
	"    os.rmdir(basename, dir_fd=parent_fd)",
	"",
	"def entry_identity(entry_stat):",
	"    return (",
	"        entry_stat.st_dev,",
	"        entry_stat.st_ino,",
	"        entry_stat.st_mode,",
	"        entry_stat.st_size,",
	"        getattr(entry_stat, 'st_mtime_ns', int(entry_stat.st_mtime * 1000000000)),",
	"        getattr(entry_stat, 'st_ctime_ns', int(entry_stat.st_ctime * 1000000000)),",
	"    )",
	"",
	"def same_identity(expected, entry_stat):",
	"    return expected == entry_identity(entry_stat)",
	"",
	"def source_changed_error(basename):",
	"    return OSError(getattr(errno, 'ESTALE', errno.EIO), 'source changed during move fallback cleanup', basename)",
	"",
	"def copy_entry(src_parent_fd, src_basename, dst_parent_fd, dst_basename):",
	"    src_stat = os.lstat(src_basename, dir_fd=src_parent_fd)",
	"    if stat.S_ISDIR(src_stat.st_mode) and not stat.S_ISLNK(src_stat.st_mode):",
	"        os.mkdir(dst_basename, stat.S_IMODE(src_stat.st_mode) or 0o755, dir_fd=dst_parent_fd)",
	"        copied_children = []",
	"        src_dir_fd = None",
	"        dst_dir_fd = None",
	"        try:",
	"            src_dir_fd = open_dir(src_basename, dir_fd=src_parent_fd)",
	"            src_stat = os.fstat(src_dir_fd)",
	"            dst_dir_fd = open_dir(dst_basename, dir_fd=dst_parent_fd)",
	"            for child in os.listdir(src_dir_fd):",
	"                copied_children.append((child, copy_entry(src_dir_fd, child, dst_dir_fd, child)))",
	"        except Exception:",
	"            if dst_dir_fd is not None:",
	"                os.close(dst_dir_fd)",
	"                dst_dir_fd = None",
	"            try:",
	"                remove_tree(dst_parent_fd, dst_basename)",
	"            except FileNotFoundError:",
	"                pass",
	"            raise",
	"        finally:",
	"            if src_dir_fd is not None:",
	"                os.close(src_dir_fd)",
	"            if dst_dir_fd is not None:",
	"                os.close(dst_dir_fd)",
	"        return ('dir', entry_identity(src_stat), copied_children)",
	"    if stat.S_ISLNK(src_stat.st_mode):",
	"        link_target = os.readlink(src_basename, dir_fd=src_parent_fd)",
	"        os.symlink(link_target, dst_basename, dir_fd=dst_parent_fd)",
	"        return ('leaf', entry_identity(src_stat), None)",
	"    src_fd = os.open(src_basename, READ_FLAGS, dir_fd=src_parent_fd)",
	"    dst_fd = None",
	"    try:",
	"        src_file_stat = os.fstat(src_fd)",
	"        if not stat.S_ISREG(src_file_stat.st_mode):",
	"            raise OSError(errno.EPERM, 'only regular files are allowed', src_basename)",
	"        if src_file_stat.st_nlink > 1:",
	"            raise OSError(errno.EPERM, 'hardlinked file is not allowed', src_basename)",
	"        dst_fd = os.open(dst_basename, WRITE_FLAGS, stat.S_IMODE(src_stat.st_mode), dir_fd=dst_parent_fd)",
	"        while True:",
	"            chunk = os.read(src_fd, 65536)",
	"            if not chunk:",
	"                break",
	"            os.write(dst_fd, chunk)",
	"        try:",
	"            os.fchmod(dst_fd, stat.S_IMODE(src_stat.st_mode))",
	"        except AttributeError:",
	"            pass",
	"        os.fsync(dst_fd)",
	"    finally:",
	"        if dst_fd is not None:",
	"            os.close(dst_fd)",
	"        os.close(src_fd)",
	"    return ('leaf', entry_identity(src_file_stat), None)",
	"",
	"def remove_copied_entry(parent_fd, basename, manifest):",
	"    kind, expected_identity, children = manifest",
	"    current_stat = os.lstat(basename, dir_fd=parent_fd)",
	"    if not same_identity(expected_identity, current_stat):",
	"        raise source_changed_error(basename)",
	"    if kind != 'dir':",
	"        os.unlink(basename, dir_fd=parent_fd)",
	"        return",
	"    dir_fd = open_dir(basename, dir_fd=parent_fd)",
	"    try:",
	"        for child, child_manifest in children:",
	"            remove_copied_entry(dir_fd, child, child_manifest)",
	"    finally:",
	"        os.close(dir_fd)",
	"    os.rmdir(basename, dir_fd=parent_fd)",
	"",
	"def move_entry(src_parent_fd, src_basename, dst_parent_fd, dst_basename):",
	"    try:",
	"        os.rename(src_basename, dst_basename, src_dir_fd=src_parent_fd, dst_dir_fd=dst_parent_fd)",
	"        os.fsync(dst_parent_fd)",
	"        os.fsync(src_parent_fd)",
	"        return",
	"    except OSError as err:",
	"        if err.errno != errno.EXDEV:",
	"            raise",
	"    src_stat = os.lstat(src_basename, dir_fd=src_parent_fd)",
	"    if stat.S_ISDIR(src_stat.st_mode) and not stat.S_ISLNK(src_stat.st_mode):",
	"        temp_dir_name = create_temp_dir(dst_parent_fd, dst_basename, stat.S_IMODE(src_stat.st_mode) or 0o755)",
	"        copied_children = []",
	"        temp_dir_fd = None",
	"        src_dir_fd = None",
	"        try:",
	"            temp_dir_fd = open_dir(temp_dir_name, dir_fd=dst_parent_fd)",
	"            src_dir_fd = open_dir(src_basename, dir_fd=src_parent_fd)",
	"            src_stat = os.fstat(src_dir_fd)",
	"            for child in os.listdir(src_dir_fd):",
	"                copied_children.append((child, copy_entry(src_dir_fd, child, temp_dir_fd, child)))",
	"            os.close(src_dir_fd)",
	"            src_dir_fd = None",
	"            os.close(temp_dir_fd)",
	"            temp_dir_fd = None",
	"            os.rename(temp_dir_name, dst_basename, src_dir_fd=dst_parent_fd, dst_dir_fd=dst_parent_fd)",
	"        except Exception:",
	"            if src_dir_fd is not None:",
	"                os.close(src_dir_fd)",
	"            if temp_dir_fd is not None:",
	"                os.close(temp_dir_fd)",
	"            try:",
	"                remove_tree(dst_parent_fd, temp_dir_name)",
	"            except FileNotFoundError:",
	"                pass",
	"            raise",
	"        remove_copied_entry(src_parent_fd, src_basename, ('dir', entry_identity(src_stat), copied_children))",
	"        os.fsync(dst_parent_fd)",
	"        os.fsync(src_parent_fd)",
	"        return",
	"    if stat.S_ISLNK(src_stat.st_mode):",
	"        link_target = os.readlink(src_basename, dir_fd=src_parent_fd)",
	"        try:",
	"            os.unlink(dst_basename, dir_fd=dst_parent_fd)",
	"        except FileNotFoundError:",
	"            pass",
	"        os.symlink(link_target, dst_basename, dir_fd=dst_parent_fd)",
	"        os.unlink(src_basename, dir_fd=src_parent_fd)",
	"        os.fsync(dst_parent_fd)",
	"        os.fsync(src_parent_fd)",
	"        return",
	"    src_fd = os.open(src_basename, READ_FLAGS, dir_fd=src_parent_fd)",
	"    temp_fd = None",
	"    temp_name = None",
	"    try:",
	"        src_file_stat = os.fstat(src_fd)",
	"        if not stat.S_ISREG(src_file_stat.st_mode):",
	"            raise OSError(errno.EPERM, 'only regular files are allowed', src_basename)",
	"        if src_file_stat.st_nlink > 1:",
	"            raise OSError(errno.EPERM, 'hardlinked file is not allowed', src_basename)",
	"        temp_name, temp_fd = create_temp_file(dst_parent_fd, dst_basename)",
	"        while True:",
	"            chunk = os.read(src_fd, 65536)",
	"            if not chunk:",
	"                break",
	"            os.write(temp_fd, chunk)",
	"        try:",
	"            os.fchmod(temp_fd, stat.S_IMODE(src_stat.st_mode))",
	"        except AttributeError:",
	"            pass",
	"        os.fsync(temp_fd)",
	"        os.close(temp_fd)",
	"        temp_fd = None",
	"        os.replace(temp_name, dst_basename, src_dir_fd=dst_parent_fd, dst_dir_fd=dst_parent_fd)",
	"        temp_name = None",
	"        os.unlink(src_basename, dir_fd=src_parent_fd)",
	"        os.fsync(dst_parent_fd)",
	"        os.fsync(src_parent_fd)",
	"    finally:",
	"        if temp_fd is not None:",
	"            os.close(temp_fd)",
	"        if temp_name is not None:",
	"            try:",
	"                os.unlink(temp_name, dir_fd=dst_parent_fd)",
	"            except FileNotFoundError:",
	"                pass",
	"        os.close(src_fd)",
	"",
	"if operation == 'write':",
	"    root_fd = open_dir(sys.argv[2])",
	"    parent_fd = None",
	"    try:",
	"        parent_fd = walk_dir(root_fd, sys.argv[3], sys.argv[5] == '1')",
	"        write_atomic(parent_fd, sys.argv[4], sys.stdin.buffer)",
	"    finally:",
	"        if parent_fd is not None:",
	"            os.close(parent_fd)",
	"        os.close(root_fd)",
	"elif operation == 'read':",
	"    root_fd = open_dir(sys.argv[2])",
	"    parent_fd = None",
	"    try:",
	"        parent_fd = walk_dir(root_fd, sys.argv[3], False)",
	"        read_file(parent_fd, sys.argv[4])",
	"    finally:",
	"        if parent_fd is not None:",
	"            os.close(parent_fd)",
	"        os.close(root_fd)",
	"elif operation == 'mkdirp':",
	"    root_fd = open_dir(sys.argv[2])",
	"    target_fd = None",
	"    try:",
	"        target_fd = walk_dir(root_fd, sys.argv[3], True)",
	"        os.fsync(target_fd)",
	"    finally:",
	"        if target_fd is not None:",
	"            os.close(target_fd)",
	"        os.close(root_fd)",
	"elif operation == 'remove':",
	"    root_fd = open_dir(sys.argv[2])",
	"    parent_fd = None",
	"    try:",
	"        parent_fd = walk_dir(root_fd, sys.argv[3], False)",
	"        try:",
	"            if sys.argv[5] == '1':",
	"                remove_tree(parent_fd, sys.argv[4])",
	"            else:",
	"                entry_stat = os.lstat(sys.argv[4], dir_fd=parent_fd)",
	"                if stat.S_ISDIR(entry_stat.st_mode) and not stat.S_ISLNK(entry_stat.st_mode):",
	"                    os.rmdir(sys.argv[4], dir_fd=parent_fd)",
	"                else:",
	"                    os.unlink(sys.argv[4], dir_fd=parent_fd)",
	"            os.fsync(parent_fd)",
	"        except FileNotFoundError:",
	"            if sys.argv[6] != '1':",
	"                raise",
	"    finally:",
	"        if parent_fd is not None:",
	"            os.close(parent_fd)",
	"        os.close(root_fd)",
	"elif operation == 'rename':",
	"    src_root_fd = open_dir(sys.argv[2])",
	"    dst_root_fd = open_dir(sys.argv[5])",
	"    src_parent_fd = None",
	"    dst_parent_fd = None",
	"    try:",
	"        src_parent_fd = walk_dir(src_root_fd, sys.argv[3], False)",
	"        dst_parent_fd = walk_dir(dst_root_fd, sys.argv[6], sys.argv[8] == '1')",
	"        move_entry(src_parent_fd, sys.argv[4], dst_parent_fd, sys.argv[7])",
	"    finally:",
	"        if src_parent_fd is not None:",
	"            os.close(src_parent_fd)",
	"        if dst_parent_fd is not None:",
	"            os.close(dst_parent_fd)",
	"        os.close(src_root_fd)",
	"        os.close(dst_root_fd)",
	"else:",
	"    raise RuntimeError('unknown sandbox mutation operation: ' + operation)"
].join("\n");
const SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL = `'${SANDBOX_PINNED_MUTATION_PYTHON.replaceAll("'", `'\\''`)}'`;
function buildPinnedMutationPlan(params) {
	return {
		checks: params.checks,
		recheckBeforeCommand: true,
		script: [
			"set -eu",
			"python_cmd=''",
			...SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES.map((candidate) => `if [ -z "$python_cmd" ] && [ -x '${candidate}' ]; then python_cmd='${candidate}'; fi`),
			"if [ -z \"$python_cmd\" ]; then python_cmd=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true); fi",
			"if [ -z \"$python_cmd\" ]; then",
			"  echo >&2 'sandbox pinned mutation helper requires python3 or python'",
			"  exit 127",
			"fi",
			`python_script=${SANDBOX_PINNED_MUTATION_PYTHON_SHELL_LITERAL}`,
			"exec \"$python_cmd\" -c \"$python_script\" \"$@\""
		].join("\n"),
		args: params.args
	};
}
function buildPinnedWritePlan(params) {
	return buildPinnedMutationPlan({
		checks: [params.check],
		args: [
			"write",
			params.pinned.mountRootPath,
			params.pinned.relativeParentPath,
			params.pinned.basename,
			params.mkdir ? "1" : "0"
		]
	});
}
function buildPinnedMkdirpPlan(params) {
	return buildPinnedMutationPlan({
		checks: [params.check],
		args: [
			"mkdirp",
			params.pinned.mountRootPath,
			params.pinned.relativePath
		]
	});
}
function buildPinnedRemovePlan(params) {
	return buildPinnedMutationPlan({
		checks: [{
			target: params.check.target,
			options: {
				...params.check.options,
				aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget
			}
		}],
		args: [
			"remove",
			params.pinned.mountRootPath,
			params.pinned.relativeParentPath,
			params.pinned.basename,
			params.recursive ? "1" : "0",
			params.force === false ? "0" : "1"
		]
	});
}
function buildPinnedRenamePlan(params) {
	return buildPinnedMutationPlan({
		checks: [{
			target: params.fromCheck.target,
			options: {
				...params.fromCheck.options,
				aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget
			}
		}, params.toCheck],
		args: [
			"rename",
			params.from.mountRootPath,
			params.from.relativeParentPath,
			params.from.basename,
			params.to.mountRootPath,
			params.to.relativeParentPath,
			params.to.basename,
			"1"
		]
	});
}
//#endregion
//#region src/agents/sandbox/fs-bridge-rename-targets.ts
function resolveWritableRenameTargets(params) {
	const action = params.action ?? "rename files";
	const from = params.resolveTarget({
		filePath: params.from,
		cwd: params.cwd
	});
	const to = params.resolveTarget({
		filePath: params.to,
		cwd: params.cwd
	});
	params.ensureWritable(from, action);
	params.ensureWritable(to, action);
	return {
		from,
		to
	};
}
function resolveWritableRenameTargetsForBridge(params, resolveTarget, ensureWritable) {
	return resolveWritableRenameTargets({
		...params,
		resolveTarget,
		ensureWritable
	});
}
function createWritableRenameTargetResolver(resolveTarget, ensureWritable) {
	return (params) => resolveWritableRenameTargetsForBridge(params, resolveTarget, ensureWritable);
}
//#endregion
//#region src/agents/sandbox/path-utils.ts
function normalizeContainerPath$1(value) {
	const normalized = path.posix.normalize(value);
	return normalized === "." ? "/" : normalized;
}
function isPathInsideContainerRoot(root, target) {
	const normalizedRoot = normalizeContainerPath$1(root);
	const normalizedTarget = normalizeContainerPath$1(target);
	if (normalizedRoot === "/") return true;
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}
function relativePathEscapesContainerRoot(relativePath) {
	return relativePath === ".." || relativePath.startsWith("../") || path.posix.isAbsolute(relativePath);
}
//#endregion
//#region src/agents/sandbox/remote-fs-bridge.ts
function createRemoteShellSandboxFsBridge(params) {
	return new RemoteShellSandboxFsBridge(params.sandbox, params.runtime);
}
var RemoteShellSandboxFsBridge = class {
	constructor(sandbox, runtime) {
		this.sandbox = sandbox;
		this.runtime = runtime;
		this.resolveRenameTargets = createWritableRenameTargetResolver((target) => this.resolveTarget(target), (target, action) => this.ensureWritable(target, action));
	}
	resolvePath(params) {
		const target = this.resolveTarget(params);
		return {
			relativePath: target.relativePath,
			containerPath: target.containerPath
		};
	}
	async readFile(params) {
		const target = this.resolveTarget(params);
		const relativePath = path.posix.relative(target.mountRootPath, target.containerPath);
		if (relativePath === "" || relativePath === "." || relativePathEscapesContainerRoot(relativePath)) throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
		return (await this.runMutation({
			args: [
				"read",
				target.mountRootPath,
				path.posix.dirname(relativePath) === "." ? "" : path.posix.dirname(relativePath),
				path.posix.basename(relativePath)
			],
			signal: params.signal
		})).stdout;
	}
	async writeFile(params) {
		const target = this.resolveTarget(params);
		this.ensureWritable(target, "write files");
		const pinned = await this.resolvePinnedParent({
			containerPath: target.containerPath,
			action: "write files",
			requireWritable: true
		});
		await this.assertNoHardlinkedFile({
			containerPath: target.containerPath,
			action: "write files",
			signal: params.signal
		});
		const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data, params.encoding ?? "utf8");
		await this.runMutation({
			args: [
				"write",
				pinned.mountRootPath,
				pinned.relativeParentPath,
				pinned.basename,
				params.mkdir !== false ? "1" : "0"
			],
			stdin: buffer,
			signal: params.signal
		});
	}
	async mkdirp(params) {
		const target = this.resolveTarget(params);
		this.ensureWritable(target, "create directories");
		const relativePath = path.posix.relative(target.mountRootPath, target.containerPath);
		if (relativePathEscapesContainerRoot(relativePath)) throw new Error(`Sandbox path escapes allowed mounts; cannot create directories: ${target.containerPath}`);
		await this.runMutation({
			args: [
				"mkdirp",
				target.mountRootPath,
				relativePath === "." ? "" : relativePath
			],
			signal: params.signal
		});
	}
	async remove(params) {
		const target = this.resolveTarget(params);
		this.ensureWritable(target, "remove files");
		if (!await this.remotePathExists(target.containerPath, params.signal)) {
			if (params.force === false) throw new Error(`Sandbox path not found; cannot remove files: ${target.containerPath}`);
			return;
		}
		const pinned = await this.resolvePinnedParent({
			containerPath: target.containerPath,
			action: "remove files",
			requireWritable: true,
			allowFinalSymlinkForUnlink: true
		});
		await this.runMutation({
			args: [
				"remove",
				pinned.mountRootPath,
				pinned.relativeParentPath,
				pinned.basename,
				params.recursive ? "1" : "0",
				params.force === false ? "0" : "1"
			],
			signal: params.signal,
			allowFailure: params.force !== false
		});
	}
	async rename(params) {
		const { from, to } = this.resolveRenameTargets(params);
		const fromPinned = await this.resolvePinnedParent({
			containerPath: from.containerPath,
			action: "rename files",
			requireWritable: true,
			allowFinalSymlinkForUnlink: true
		});
		const toPinned = await this.resolvePinnedParent({
			containerPath: to.containerPath,
			action: "rename files",
			requireWritable: true
		});
		await this.runMutation({
			args: [
				"rename",
				fromPinned.mountRootPath,
				fromPinned.relativeParentPath,
				fromPinned.basename,
				toPinned.mountRootPath,
				toPinned.relativeParentPath,
				toPinned.basename,
				"1"
			],
			signal: params.signal
		});
	}
	async stat(params) {
		const target = this.resolveTarget(params);
		if (!await this.remotePathExists(target.containerPath, params.signal)) return null;
		const canonical = await this.resolveCanonicalPath({
			containerPath: target.containerPath,
			action: "stat files",
			signal: params.signal
		});
		await this.assertNoHardlinkedFile({
			containerPath: canonical,
			action: "stat files",
			signal: params.signal
		});
		const [kindRaw = "", sizeRaw = "0", mtimeRaw = "0"] = (await this.runRemoteScript({
			script: "set -eu\nstat -c \"%F|%s|%Y\" -- \"$1\"",
			args: [canonical],
			signal: params.signal
		})).stdout.toString("utf8").trim().split("|");
		return {
			type: kindRaw === "directory" ? "directory" : kindRaw === "regular file" ? "file" : "other",
			size: Number(sizeRaw),
			mtimeMs: Number(mtimeRaw) * 1e3
		};
	}
	getMounts() {
		const mounts = [{
			containerRoot: normalizeContainerPath(this.runtime.remoteWorkspaceDir),
			writable: this.sandbox.workspaceAccess === "rw",
			source: "workspace"
		}];
		if (this.sandbox.workspaceAccess !== "none" && path.resolve(this.sandbox.agentWorkspaceDir) !== path.resolve(this.sandbox.workspaceDir)) mounts.push({
			containerRoot: normalizeContainerPath(this.runtime.remoteAgentWorkspaceDir),
			writable: this.sandbox.workspaceAccess === "rw",
			source: "agent"
		});
		return mounts;
	}
	resolveTarget(params) {
		const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
		const agentRoot = path.resolve(this.sandbox.agentWorkspaceDir);
		const workspaceContainerRoot = normalizeContainerPath(this.runtime.remoteWorkspaceDir);
		const agentContainerRoot = normalizeContainerPath(this.runtime.remoteAgentWorkspaceDir);
		const mounts = this.getMounts();
		const input = params.filePath.trim();
		const inputPosix = input.replace(/\\/g, "/");
		const maybeContainerMount = path.posix.isAbsolute(inputPosix) ? this.resolveMountByContainerPath(mounts, normalizeContainerPath(inputPosix)) : null;
		if (maybeContainerMount) return this.toResolvedPath({
			mount: maybeContainerMount,
			containerPath: normalizeContainerPath(inputPosix)
		});
		const hostCwd = params.cwd ? path.resolve(params.cwd) : workspaceRoot;
		const hostCandidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(hostCwd, input);
		if (isPathInside(workspaceRoot, hostCandidate)) {
			const relative = toPosixRelative(workspaceRoot, hostCandidate);
			return this.toResolvedPath({
				mount: mounts[0],
				containerPath: relative ? path.posix.join(workspaceContainerRoot, relative) : workspaceContainerRoot
			});
		}
		if (mounts[1] && isPathInside(agentRoot, hostCandidate)) {
			const relative = toPosixRelative(agentRoot, hostCandidate);
			return this.toResolvedPath({
				mount: mounts[1],
				containerPath: relative ? path.posix.join(agentContainerRoot, relative) : agentContainerRoot
			});
		}
		if (params.cwd) {
			const cwdPosix = params.cwd.replace(/\\/g, "/");
			if (path.posix.isAbsolute(cwdPosix)) {
				const cwdContainer = normalizeContainerPath(cwdPosix);
				const cwdMount = this.resolveMountByContainerPath(mounts, cwdContainer);
				if (cwdMount) return this.toResolvedPath({
					mount: cwdMount,
					containerPath: normalizeContainerPath(path.posix.resolve(cwdContainer, inputPosix))
				});
			}
		}
		throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.filePath}`);
	}
	toResolvedPath(params) {
		const relative = path.posix.relative(params.mount.containerRoot, params.containerPath);
		if (relativePathEscapesContainerRoot(relative)) throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.containerPath}`);
		return {
			relativePath: params.mount.source === "workspace" ? relative === "." ? "" : relative : relative === "." ? params.mount.containerRoot : `${params.mount.containerRoot}/${relative}`,
			containerPath: params.containerPath,
			writable: params.mount.writable,
			mountRootPath: params.mount.containerRoot,
			source: params.mount.source
		};
	}
	resolveMountByContainerPath(mounts, containerPath) {
		const ordered = [...mounts].toSorted((a, b) => b.containerRoot.length - a.containerRoot.length);
		for (const mount of ordered) if (isPathInsideContainerRoot(mount.containerRoot, containerPath)) return mount;
		return null;
	}
	ensureWritable(target, action) {
		if (this.sandbox.workspaceAccess !== "rw" || !target.writable) throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
	}
	async remotePathExists(containerPath, signal) {
		return (await this.runRemoteScript({
			script: "if [ -e \"$1\" ] || [ -L \"$1\" ]; then printf \"1\\n\"; else printf \"0\\n\"; fi",
			args: [containerPath],
			signal
		})).stdout.toString("utf8").trim() === "1";
	}
	async resolveCanonicalPath(params) {
		const script = [
			"set -eu",
			"target=\"$1\"",
			"allow_final=\"$2\"",
			"suffix=\"\"",
			"probe=\"$target\"",
			"if [ \"$allow_final\" = \"1\" ] && [ -L \"$target\" ]; then probe=$(dirname -- \"$target\"); fi",
			"cursor=\"$probe\"",
			"while [ ! -e \"$cursor\" ] && [ ! -L \"$cursor\" ]; do",
			"  parent=$(dirname -- \"$cursor\")",
			"  if [ \"$parent\" = \"$cursor\" ]; then break; fi",
			"  base=$(basename -- \"$cursor\")",
			"  suffix=\"/$base$suffix\"",
			"  cursor=\"$parent\"",
			"done",
			"canonical=$(readlink -f -- \"$cursor\")",
			"printf \"%s%s\\n\" \"$canonical\" \"$suffix\""
		].join("\n");
		const canonical = normalizeContainerPath((await this.runRemoteScript({
			script,
			args: [params.containerPath, params.allowFinalSymlinkForUnlink ? "1" : "0"],
			signal: params.signal
		})).stdout.toString("utf8").trim());
		if (!this.resolveMountByContainerPath(this.getMounts(), canonical)) throw new Error(`Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`);
		return canonical;
	}
	async assertNoHardlinkedFile(params) {
		const output = (await this.runRemoteScript({
			script: [
				"if [ ! -e \"$1\" ] && [ ! -L \"$1\" ]; then exit 0; fi",
				"stats=$(stat -c \"%F|%h\" -- \"$1\")",
				"printf \"%s\\n\" \"$stats\""
			].join("\n"),
			args: [params.containerPath],
			signal: params.signal,
			allowFailure: true
		})).stdout.toString("utf8").trim();
		if (!output) return;
		const [kind = "", linksRaw = "1"] = output.split("|");
		if (kind === "regular file" && Number(linksRaw) > 1) throw new Error(`Hardlinked path is not allowed under sandbox mount root: ${params.containerPath}`);
	}
	async resolvePinnedParent(params) {
		const basename = path.posix.basename(params.containerPath);
		if (!basename || basename === "." || basename === "/") throw new Error(`Invalid sandbox entry target: ${params.containerPath}`);
		const canonicalParent = await this.resolveCanonicalPath({
			containerPath: normalizeContainerPath(path.posix.dirname(params.containerPath)),
			action: params.action,
			allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink
		});
		const mount = this.resolveMountByContainerPath(this.getMounts(), canonicalParent);
		if (!mount) throw new Error(`Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`);
		if (params.requireWritable && !mount.writable) throw new Error(`Sandbox path is read-only; cannot ${params.action}: ${params.containerPath}`);
		const relativeParentPath = path.posix.relative(mount.containerRoot, canonicalParent);
		if (relativePathEscapesContainerRoot(relativeParentPath)) throw new Error(`Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`);
		return {
			mountRootPath: mount.containerRoot,
			relativeParentPath: relativeParentPath === "." ? "" : relativeParentPath,
			basename
		};
	}
	async runMutation(params) {
		return await this.runRemoteScript({
			script: [
				"set -eu",
				"python3 /dev/fd/3 \"$@\" 3<<'PY'",
				SANDBOX_PINNED_MUTATION_PYTHON,
				"PY"
			].join("\n"),
			args: params.args,
			stdin: params.stdin,
			signal: params.signal,
			allowFailure: params.allowFailure
		});
	}
	async runRemoteScript(params) {
		return await this.runtime.runRemoteShellScript({
			script: params.script,
			args: params.args,
			stdin: params.stdin,
			signal: params.signal,
			allowFailure: params.allowFailure
		});
	}
};
function normalizeContainerPath(value) {
	const normalized = normalizeContainerPath$1(value.trim() || "/");
	return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
function toPosixRelative(root, candidate) {
	return path.relative(root, candidate).split(path.sep).filter(Boolean).join(path.posix.sep);
}
//#endregion
//#region src/agents/sandbox/ssh.ts
function normalizeInlineSshMaterial(contents, filename) {
	const normalizedEscapedNewlines = contents.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");
	const expanded = filename === "identity" || filename === "certificate.pub" ? normalizedEscapedNewlines.replace(/\\n/g, "\n") : normalizedEscapedNewlines;
	return expanded.endsWith("\n") ? expanded : `${expanded}\n`;
}
function buildSshFailureMessage(stderr, exitCode) {
	const trimmed = stderr.trim();
	if (trimmed.includes("error in libcrypto") && (trimmed.includes("Load key \"") || trimmed.includes("Permission denied (publickey)"))) return `${trimmed}\nSSH sandbox failed to load the configured identity. The private key contents may be malformed (for example CRLF or escaped newlines). Prefer identityFile when possible.`;
	return trimmed || (exitCode !== void 0 ? `ssh exited with code ${exitCode}` : "ssh exited with a non-zero status");
}
function shellEscape(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function buildRemoteCommand(argv) {
	return argv.map((entry) => shellEscape(entry)).join(" ");
}
function buildExecRemoteCommand(params) {
	const body = params.workdir ? `cd ${shellEscape(params.workdir)} && ${params.command}` : params.command;
	return buildRemoteCommand(Object.keys(params.env).length > 0 ? [
		"env",
		...Object.entries(params.env).map(([key, value]) => `${key}=${value}`),
		"/bin/sh",
		"-c",
		body
	] : [
		"/bin/sh",
		"-c",
		body
	]);
}
function buildSshSandboxArgv(params) {
	return [
		params.session.command,
		"-F",
		params.session.configPath,
		...params.tty ? [
			"-tt",
			"-o",
			"RequestTTY=force",
			"-o",
			"SetEnv=TERM=xterm-256color"
		] : [
			"-T",
			"-o",
			"RequestTTY=no"
		],
		params.session.host,
		params.remoteCommand
	];
}
async function createSshSandboxSessionFromConfigText(params) {
	const host = params.host?.trim() || parseSshConfigHost(params.configText);
	if (!host) throw new Error("Failed to parse SSH config output.");
	const configDir = await fs.mkdtemp(path.join(resolveSshTmpRoot(), "openclaw-sandbox-ssh-"));
	const configPath = path.join(configDir, "config");
	await fs.writeFile(configPath, params.configText, {
		encoding: "utf8",
		mode: 384
	});
	await fs.chmod(configPath, 384);
	return {
		command: params.command?.trim() || "ssh",
		configPath,
		host
	};
}
async function createSshSandboxSessionFromSettings(settings) {
	const parsed = parseSshTarget(settings.target);
	if (!parsed) throw new Error(`Invalid sandbox SSH target: ${settings.target}`);
	const configDir = await fs.mkdtemp(path.join(resolveSshTmpRoot(), "openclaw-sandbox-ssh-"));
	try {
		const materializedIdentity = settings.identityData ? await writeSecretMaterial(configDir, "identity", settings.identityData) : void 0;
		const materializedCertificate = settings.certificateData ? await writeSecretMaterial(configDir, "certificate.pub", settings.certificateData) : void 0;
		const materializedKnownHosts = settings.knownHostsData ? await writeSecretMaterial(configDir, "known_hosts", settings.knownHostsData) : void 0;
		const identityFile = materializedIdentity ?? resolveOptionalLocalPath(settings.identityFile);
		const certificateFile = materializedCertificate ?? resolveOptionalLocalPath(settings.certificateFile);
		const knownHostsFile = materializedKnownHosts ?? resolveOptionalLocalPath(settings.knownHostsFile);
		const hostAlias = "openclaw-sandbox";
		const configPath = path.join(configDir, "config");
		const lines = [
			`Host ${hostAlias}`,
			`  HostName ${parsed.host}`,
			`  Port ${parsed.port}`,
			"  BatchMode yes",
			"  ConnectTimeout 5",
			"  ServerAliveInterval 15",
			"  ServerAliveCountMax 3",
			`  StrictHostKeyChecking ${settings.strictHostKeyChecking ? "yes" : "no"}`,
			`  UpdateHostKeys ${settings.updateHostKeys ? "yes" : "no"}`
		];
		if (parsed.user) lines.push(`  User ${parsed.user}`);
		if (knownHostsFile) lines.push(`  UserKnownHostsFile ${knownHostsFile}`);
		else if (!settings.strictHostKeyChecking) lines.push("  UserKnownHostsFile /dev/null");
		if (identityFile) lines.push(`  IdentityFile ${identityFile}`);
		if (certificateFile) lines.push(`  CertificateFile ${certificateFile}`);
		if (identityFile || certificateFile) lines.push("  IdentitiesOnly yes");
		await fs.writeFile(configPath, `${lines.join("\n")}\n`, {
			encoding: "utf8",
			mode: 384
		});
		await fs.chmod(configPath, 384);
		return {
			command: settings.command.trim() || "ssh",
			configPath,
			host: hostAlias
		};
	} catch (error) {
		await fs.rm(configDir, {
			recursive: true,
			force: true
		});
		throw error;
	}
}
async function disposeSshSandboxSession(session) {
	await fs.rm(path.dirname(session.configPath), {
		recursive: true,
		force: true
	});
}
async function runSshSandboxCommand(params) {
	const argv = buildSshSandboxArgv({
		session: params.session,
		remoteCommand: params.remoteCommand,
		tty: params.tty
	});
	const sshEnv = sanitizeEnvVars(process.env).allowed;
	return await new Promise((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: sshEnv,
			signal: params.signal
		});
		const stdoutChunks = [];
		const stderrChunks = [];
		child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (code) => {
			const stdout = Buffer.concat(stdoutChunks);
			const stderr = Buffer.concat(stderrChunks);
			const exitCode = code ?? 0;
			if (exitCode !== 0 && !params.allowFailure) {
				reject(Object.assign(new Error(buildSshFailureMessage(stderr.toString("utf8"), exitCode)), {
					code: exitCode,
					stdout,
					stderr
				}));
				return;
			}
			resolve({
				stdout,
				stderr,
				code: exitCode
			});
		});
		if (params.stdin !== void 0) {
			child.stdin.end(params.stdin);
			return;
		}
		child.stdin.end();
	});
}
async function uploadDirectoryToSshTarget(params) {
	await assertSafeUploadSymlinks(params.localDir);
	const remoteCommand = buildRemoteCommand([
		"/bin/sh",
		"-c",
		"mkdir -p -- \"$1\" && tar -xf - -C \"$1\"",
		"openclaw-sandbox-upload",
		params.remoteDir
	]);
	const sshArgv = buildSshSandboxArgv({
		session: params.session,
		remoteCommand
	});
	const sshEnv = sanitizeEnvVars(process.env).allowed;
	await new Promise((resolve, reject) => {
		const tar = spawn("tar", [
			"-C",
			params.localDir,
			"-cf",
			"-",
			"."
		], {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			signal: params.signal
		});
		const ssh = spawn(sshArgv[0], sshArgv.slice(1), {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: sshEnv,
			signal: params.signal
		});
		const tarStderr = [];
		const sshStdout = [];
		const sshStderr = [];
		let tarClosed = false;
		let sshClosed = false;
		let tarCode = 0;
		let sshCode = 0;
		tar.stderr.on("data", (chunk) => tarStderr.push(Buffer.from(chunk)));
		ssh.stdout.on("data", (chunk) => sshStdout.push(Buffer.from(chunk)));
		ssh.stderr.on("data", (chunk) => sshStderr.push(Buffer.from(chunk)));
		const fail = (error) => {
			tar.kill("SIGKILL");
			ssh.kill("SIGKILL");
			reject(error);
		};
		tar.on("error", fail);
		ssh.on("error", fail);
		tar.stdout.pipe(ssh.stdin);
		tar.on("close", (code) => {
			tarClosed = true;
			tarCode = code ?? 0;
			maybeResolve();
		});
		ssh.on("close", (code) => {
			sshClosed = true;
			sshCode = code ?? 0;
			maybeResolve();
		});
		function maybeResolve() {
			if (!tarClosed || !sshClosed) return;
			if (tarCode !== 0) {
				reject(new Error(Buffer.concat(tarStderr).toString("utf8").trim() || `tar exited with code ${tarCode}`));
				return;
			}
			if (sshCode !== 0) {
				reject(new Error(Buffer.concat(sshStderr).toString("utf8").trim() || `ssh exited with code ${sshCode}`));
				return;
			}
			resolve();
		}
	});
}
async function assertSafeUploadSymlinks(localDir) {
	const rootDir = path.resolve(localDir);
	await walkDirectory(rootDir);
	async function walkDirectory(currentDir) {
		const entries = await fs.readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(currentDir, entry.name);
			if (entry.isSymbolicLink()) {
				try {
					await resolveRootPath({
						absolutePath: entryPath,
						rootPath: rootDir,
						boundaryLabel: "SSH sandbox upload tree"
					});
				} catch (error) {
					const relativePath = path.relative(rootDir, entryPath).split(path.sep).join("/");
					throw new Error(`SSH sandbox upload refuses symlink escaping the workspace: ${relativePath}`, { cause: error });
				}
				continue;
			}
			if (entry.isDirectory()) await walkDirectory(entryPath);
		}
	}
}
function parseSshConfigHost(configText) {
	return configText.match(/^\s*Host\s+(\S+)/m)?.[1]?.trim() || null;
}
function resolveSshTmpRoot() {
	return path.resolve(resolvePreferredOpenClawTmpDir() ?? os.tmpdir());
}
function resolveOptionalLocalPath(value) {
	const trimmed = value?.trim();
	return trimmed ? resolveUserPath(trimmed) : void 0;
}
async function writeSecretMaterial(dir, filename, contents) {
	const pathname = path.join(dir, filename);
	await fs.writeFile(pathname, normalizeInlineSshMaterial(contents, filename), {
		encoding: "utf8",
		mode: 384
	});
	await fs.chmod(pathname, 384);
	return pathname;
}
//#endregion
//#region src/agents/sandbox/ssh-backend.ts
const sshSandboxBackendManager = {
	async describeRuntime({ entry, config, agentId }) {
		const cfg = resolveSandboxConfigForAgent(config, agentId);
		if (cfg.backend !== "ssh" || !cfg.ssh.target) return {
			running: false,
			actualConfigLabel: cfg.ssh.target,
			configLabelMatch: false
		};
		const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
		const session = await createSshSandboxSessionFromSettings({
			...cfg.ssh,
			target: cfg.ssh.target
		});
		try {
			return {
				running: (await runSshSandboxCommand({
					session,
					remoteCommand: buildRemoteCommand([
						"/bin/sh",
						"-c",
						"if [ -d \"$1\" ]; then printf \"1\\n\"; else printf \"0\\n\"; fi",
						"openclaw-sandbox-check",
						runtimePaths.runtimeRootDir
					])
				})).stdout.toString("utf8").trim() === "1",
				actualConfigLabel: cfg.ssh.target,
				configLabelMatch: entry.image === cfg.ssh.target
			};
		} finally {
			await disposeSshSandboxSession(session);
		}
	},
	async removeRuntime({ entry, config, agentId }) {
		const cfg = resolveSandboxConfigForAgent(config, agentId);
		if (cfg.backend !== "ssh" || !cfg.ssh.target) return;
		const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
		const session = await createSshSandboxSessionFromSettings({
			...cfg.ssh,
			target: cfg.ssh.target
		});
		try {
			await runSshSandboxCommand({
				session,
				remoteCommand: buildRemoteCommand([
					"/bin/sh",
					"-c",
					"rm -rf -- \"$1\"",
					"openclaw-sandbox-remove",
					runtimePaths.runtimeRootDir
				]),
				allowFailure: true
			});
		} finally {
			await disposeSshSandboxSession(session);
		}
	}
};
async function createSshSandboxBackend(params) {
	if ((params.cfg.docker.binds?.length ?? 0) > 0) throw new Error("SSH sandbox backend does not support sandbox.docker.binds.");
	const target = params.cfg.ssh.target;
	if (!target) throw new Error("Sandbox backend \"ssh\" requires agents.defaults.sandbox.ssh.target.");
	return new SshSandboxBackendImpl({
		createParams: params,
		target,
		runtimePaths: resolveSshRuntimePaths(params.cfg.ssh.workspaceRoot, params.scopeKey)
	}).asHandle();
}
var SshSandboxBackendImpl = class {
	constructor(params) {
		this.params = params;
		this.ensurePromise = null;
	}
	asHandle() {
		return {
			id: "ssh",
			runtimeId: this.params.runtimePaths.runtimeId,
			runtimeLabel: this.params.runtimePaths.runtimeId,
			workdir: this.params.runtimePaths.remoteWorkspaceDir,
			env: this.params.createParams.cfg.docker.env,
			configLabel: this.params.target,
			configLabelKind: "Target",
			remoteWorkspaceDir: this.params.runtimePaths.remoteWorkspaceDir,
			remoteAgentWorkspaceDir: this.params.runtimePaths.remoteAgentWorkspaceDir,
			buildExecSpec: async ({ command, workdir, env, usePty }) => {
				await this.ensureRuntime();
				const sshSession = await this.createSession();
				return {
					argv: buildSshSandboxArgv({
						session: sshSession,
						remoteCommand: buildExecRemoteCommand({
							command,
							workdir: workdir ?? this.params.runtimePaths.remoteWorkspaceDir,
							env
						}),
						tty: usePty
					}),
					env: sanitizeEnvVars(process.env).allowed,
					stdinMode: "pipe-open",
					finalizeToken: { sshSession }
				};
			},
			finalizeExec: async ({ token }) => {
				const sshSession = token?.sshSession;
				if (sshSession) await disposeSshSandboxSession(sshSession);
			},
			runShellCommand: async (command) => await this.runRemoteShellScript(command),
			createFsBridge: ({ sandbox }) => createRemoteShellSandboxFsBridge({
				sandbox,
				runtime: this.asHandle()
			}),
			runRemoteShellScript: async (command) => await this.runRemoteShellScript(command)
		};
	}
	async createSession() {
		return await createSshSandboxSessionFromSettings({
			...this.params.createParams.cfg.ssh,
			target: this.params.target
		});
	}
	async ensureRuntime() {
		if (this.ensurePromise) return await this.ensurePromise;
		this.ensurePromise = this.ensureRuntimeInner();
		try {
			await this.ensurePromise;
		} catch (error) {
			this.ensurePromise = null;
			throw error;
		}
	}
	async ensureRuntimeInner() {
		const session = await this.createSession();
		try {
			if ((await runSshSandboxCommand({
				session,
				remoteCommand: buildRemoteCommand([
					"/bin/sh",
					"-c",
					"if [ -d \"$1\" ]; then printf \"1\\n\"; else printf \"0\\n\"; fi",
					"openclaw-sandbox-check",
					this.params.runtimePaths.runtimeRootDir
				])
			})).stdout.toString("utf8").trim() === "1") return;
			await this.replaceRemoteDirectoryFromLocal(session, this.params.createParams.workspaceDir, this.params.runtimePaths.remoteWorkspaceDir);
			if (this.params.createParams.cfg.workspaceAccess !== "none" && path.resolve(this.params.createParams.agentWorkspaceDir) !== path.resolve(this.params.createParams.workspaceDir)) await this.replaceRemoteDirectoryFromLocal(session, this.params.createParams.agentWorkspaceDir, this.params.runtimePaths.remoteAgentWorkspaceDir);
		} finally {
			await disposeSshSandboxSession(session);
		}
	}
	async replaceRemoteDirectoryFromLocal(session, localDir, remoteDir) {
		await runSshSandboxCommand({
			session,
			remoteCommand: buildRemoteCommand([
				"/bin/sh",
				"-c",
				"mkdir -p -- \"$1\" && find \"$1\" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
				"openclaw-sandbox-clear",
				remoteDir
			])
		});
		await uploadDirectoryToSshTarget({
			session,
			localDir,
			remoteDir
		});
	}
	async runRemoteShellScript(params) {
		await this.ensureRuntime();
		const session = await this.createSession();
		try {
			return await runSshSandboxCommand({
				session,
				remoteCommand: buildRemoteCommand([
					"/bin/sh",
					"-c",
					params.script,
					"openclaw-sandbox-fs",
					...params.args ?? []
				]),
				stdin: params.stdin,
				allowFailure: params.allowFailure,
				signal: params.signal
			});
		} finally {
			await disposeSshSandboxSession(session);
		}
	}
};
function resolveSshRuntimePaths(workspaceRoot, scopeKey) {
	const runtimeId = buildSshSandboxRuntimeId(scopeKey);
	const runtimeRootDir = path.posix.join(workspaceRoot, runtimeId);
	return {
		runtimeId,
		runtimeRootDir,
		remoteWorkspaceDir: path.posix.join(runtimeRootDir, "workspace"),
		remoteAgentWorkspaceDir: path.posix.join(runtimeRootDir, "agent")
	};
}
function buildSshSandboxRuntimeId(scopeKey) {
	const trimmed = scopeKey.trim() || "session";
	const safe = normalizeLowercaseStringOrEmpty(trimmed).replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	const hash = Array.from(trimmed).reduce((acc, char) => (acc * 33 ^ char.charCodeAt(0)) >>> 0, 5381);
	return `openclaw-ssh-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
//#endregion
//#region src/agents/sandbox/backend.ts
const SANDBOX_BACKEND_FACTORIES_STATE_KEY = Symbol.for("openclaw.sandboxBackendFactories");
function getSandboxBackendFactories() {
	const globalStore = globalThis;
	globalStore[SANDBOX_BACKEND_FACTORIES_STATE_KEY] ??= /* @__PURE__ */ new Map();
	return globalStore[SANDBOX_BACKEND_FACTORIES_STATE_KEY];
}
function normalizeSandboxBackendId(id) {
	const normalized = normalizeOptionalLowercaseString(id);
	if (!normalized) throw new Error("Sandbox backend id must not be empty.");
	return normalized;
}
function registerSandboxBackend(id, registration) {
	const normalizedId = normalizeSandboxBackendId(id);
	const resolved = typeof registration === "function" ? { factory: registration } : registration;
	const factories = getSandboxBackendFactories();
	const previous = factories.get(normalizedId);
	factories.set(normalizedId, resolved);
	return () => {
		const currentFactories = getSandboxBackendFactories();
		if (previous) {
			currentFactories.set(normalizedId, previous);
			return;
		}
		currentFactories.delete(normalizedId);
	};
}
function getSandboxBackendFactory(id) {
	return getSandboxBackendFactories().get(normalizeSandboxBackendId(id))?.factory ?? null;
}
function getSandboxBackendManager(id) {
	return getSandboxBackendFactories().get(normalizeSandboxBackendId(id))?.manager ?? null;
}
function requireSandboxBackendFactory(id) {
	const factory = getSandboxBackendFactory(id);
	if (factory) return factory;
	throw new Error([`Sandbox backend "${id}" is not registered.`, "Load the plugin that provides it, or set agents.defaults.sandbox.backend=docker."].join("\n"));
}
registerSandboxBackend("docker", {
	factory: createDockerSandboxBackend,
	manager: dockerSandboxBackendManager
});
registerSandboxBackend("ssh", {
	factory: createSshSandboxBackend,
	manager: sshSandboxBackendManager
});
//#endregion
//#region src/plugin-sdk/browser-bridge.ts
function loadFacadeModule() {
	return loadActivatedBundledPluginPublicSurfaceModuleSync({
		dirName: "browser",
		artifactBasename: "runtime-api.js"
	});
}
async function startBrowserBridgeServer(params) {
	return await loadFacadeModule().startBrowserBridgeServer(params);
}
async function stopBrowserBridgeServer(server) {
	await loadFacadeModule().stopBrowserBridgeServer(server);
}
//#endregion
//#region src/agents/sandbox/browser-bridges.ts
const BROWSER_BRIDGES = /* @__PURE__ */ new Map();
//#endregion
export { resolveWritableRenameTargetsForBridge as C, buildPinnedWritePlan as D, buildPinnedRenamePlan as E, dockerSandboxBackendManager as O, resolveWritableRenameTargets as S, buildPinnedRemovePlan as T, createRemoteShellSandboxFsBridge as _, getSandboxBackendManager as a, relativePathEscapesContainerRoot as b, buildExecRemoteCommand as c, createSshSandboxSessionFromConfigText as d, createSshSandboxSessionFromSettings as f, uploadDirectoryToSshTarget as g, shellEscape as h, getSandboxBackendFactory as i, runDockerSandboxShellCommand as k, buildRemoteCommand as l, runSshSandboxCommand as m, startBrowserBridgeServer as n, registerSandboxBackend as o, disposeSshSandboxSession as p, stopBrowserBridgeServer as r, requireSandboxBackendFactory as s, BROWSER_BRIDGES as t, buildSshSandboxArgv as u, isPathInsideContainerRoot as v, buildPinnedMkdirpPlan as w, createWritableRenameTargetResolver as x, normalizeContainerPath$1 as y };
