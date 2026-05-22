import { r as getFsSafePythonConfig, t as canFallbackFromPythonError } from "./fs-safe-defaults-B7hUN42l.js";
import { i as isPathInside, m as FsSafeError, n as hasNodeErrorCode, o as isPathRelativeEscape, r as isNotFoundPathError, s as isSymlinkOpenError, t as assertNoNulPathInput } from "./path-BlG8lhgR.js";
import { t as sameFileIdentity } from "./file-identity-BKNyWMFA.js";
import { n as normalizeOptionalString } from "./string-coerce-6TL5VVOL.js";
import { c as assertAsyncDirectoryGuard, d as createNearestExistingDirectoryGuard, n as registerTempPathForExit, s as withAsyncDirectoryGuards, t as serializePathWrite, u as createAsyncDirectoryGuard } from "./write-queue-C9nceBqy.js";
import { r as resolveRootPath, t as ROOT_PATH_ALIAS_POLICIES } from "./root-path-BgCKz8X4.js";
import { t as stringifyJsonDocument } from "./json-stringify-DYDqVIo7.js";
import fs, { constants } from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
//#region node_modules/@openclaw/fs-safe/dist/home-dir.js
function normalize$1(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	if (trimmed === "undefined" || trimmed === "null") return;
	return trimmed;
}
function resolveEffectiveHomeDir(env = process.env, homedir = os.homedir) {
	const raw = resolveRawHomeDir(env, homedir);
	return raw ? path.resolve(raw) : void 0;
}
function resolveRawHomeDir(env, homedir) {
	const explicitHome = normalize$1(env.OPENCLAW_HOME);
	if (!explicitHome) return resolveRawOsHomeDir(env, homedir);
	if (path.normalize(explicitHome).split(path.sep)[0] !== "~") return explicitHome;
	const fallbackHome = resolveRawOsHomeDir(env, homedir);
	if (!fallbackHome) return;
	return expandHomePrefix(explicitHome, { home: fallbackHome });
}
function resolveRawOsHomeDir(env, homedir) {
	const envHome = normalize$1(env.HOME);
	if (envHome) return envHome;
	const userProfile = normalize$1(env.USERPROFILE);
	if (userProfile) return userProfile;
	return normalizeSafe(homedir);
}
function normalizeSafe(homedir) {
	try {
		return normalize$1(homedir());
	} catch {
		return;
	}
}
function resolveRequiredHomeDir(env = process.env, homedir = os.homedir) {
	return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
function expandHomePrefix(input, opts) {
	const segments = path.normalize(input).split(path.sep);
	if (segments[0] !== "~") return input;
	const home = normalize$1(opts?.home) ?? resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
	if (!home) return input;
	return path.join(home, ...segments.slice(1));
}
function resolveHomeRelativePath(input, opts) {
	if (!input) return input;
	if (path.normalize(input).split(path.sep)[0] !== "~") return path.resolve(input);
	const expanded = expandHomePrefix(input, {
		home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
		env: opts?.env,
		homedir: opts?.homedir
	});
	return path.resolve(expanded);
}
function resolveUserPath(input, optsOrEnv, homedir) {
	return resolveHomeRelativePath(input, optsOrEnv && ("env" in optsOrEnv || "homedir" in optsOrEnv) ? optsOrEnv : {
		env: optsOrEnv,
		homedir
	});
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/bounded-read-stream.js
function createMaxBytesTransform(maxBytes) {
	let bytes = 0;
	return new Transform({ transform(chunk, _encoding, callback) {
		const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > maxBytes) {
			callback(new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`));
			return;
		}
		callback(null, buffer);
	} });
}
function createBoundedReadStream(opened, maxBytes) {
	const stream = opened.handle.createReadStream();
	return maxBytes === void 0 ? stream : stream.pipe(createMaxBytesTransform(maxBytes));
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/guarded-mkdir.js
function isSameOrChildPath(candidate, parent) {
	const parentPrefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
	return candidate === parent || candidate.startsWith(parentPrefix);
}
async function mkdirPathComponentsWithGuards(params) {
	const root = path.resolve(params.rootReal);
	const rootCanonical = path.resolve(await fs$1.realpath(root));
	const target = path.resolve(params.targetPath);
	const relative = path.relative(root, target);
	if (isPathRelativeEscape(relative)) throw new FsSafeError("outside-workspace", "directory is outside workspace root");
	let current = root;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		const next = path.join(current, part);
		const parentGuard = await createAsyncDirectoryGuard(current);
		await params.beforeComponent?.(next);
		await assertAsyncDirectoryGuard(parentGuard);
		try {
			await fs$1.mkdir(next);
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
		}
		const stat = await fs$1.lstat(next);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FsSafeError("not-file", "directory component must be a directory");
		if (!isSameOrChildPath(path.resolve(await fs$1.realpath(next)), rootCanonical)) throw new FsSafeError("outside-workspace", "directory escaped workspace root");
		await createAsyncDirectoryGuard(next);
		await assertAsyncDirectoryGuard(parentGuard);
		current = next;
	}
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/pinned-python.js
const PINNED_PYTHON_WORKER_SOURCE = String.raw`
import base64, errno, json, os, secrets, stat, sys
DIR_FLAGS = os.O_RDONLY
if hasattr(os, "O_DIRECTORY"):
    DIR_FLAGS |= os.O_DIRECTORY
if hasattr(os, "O_NOFOLLOW"):
    DIR_FLAGS |= os.O_NOFOLLOW
READ_FLAGS = os.O_RDONLY
if hasattr(os, "O_NONBLOCK"):
    READ_FLAGS |= os.O_NONBLOCK
if hasattr(os, "O_NOFOLLOW"):
    READ_FLAGS |= os.O_NOFOLLOW
WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    WRITE_FLAGS |= os.O_NOFOLLOW
def split_relative(value):
    if value in ("", "."):
        return []
    if "\x00" in value or value.startswith("/") or value.startswith("//"):
        raise OSError(errno.EPERM, "invalid relative path")
    if value.startswith("..\\"):
        raise OSError(errno.EPERM, "path traversal is not allowed")
    parts = [part for part in value.split("/") if part and part != "."]
    for part in parts:
        if part == "..":
            raise OSError(errno.EPERM, "path traversal is not allowed")
    return parts
def open_dir(path_value, dir_fd=None):
    return os.open(path_value, DIR_FLAGS, dir_fd=dir_fd)
def walk_dir(root_fd, segments, mkdir_enabled=False):
    current_fd = os.dup(root_fd)
    try:
        for segment in segments:
            try:
                next_fd = open_dir(segment, dir_fd=current_fd)
            except FileNotFoundError:
                if not mkdir_enabled:
                    raise
                os.mkdir(segment, 0o777, dir_fd=current_fd)
                next_fd = open_dir(segment, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except Exception:
        os.close(current_fd)
        raise
def parent_and_basename(root_fd, relative):
    segments = split_relative(relative)
    if not segments:
        raise OSError(errno.EPERM, "operation requires a non-root path")
    parent_fd = walk_dir(root_fd, segments[:-1])
    return parent_fd, segments[-1]
def encode_stat(st):
    mode = st.st_mode
    return {
        "dev": st.st_dev,
        "gid": st.st_gid,
        "ino": st.st_ino,
        "isDirectory": stat.S_ISDIR(mode),
        "isFile": stat.S_ISREG(mode),
        "isSymbolicLink": stat.S_ISLNK(mode),
        "mode": mode,
        "mtimeMs": st.st_mtime * 1000,
        "nlink": st.st_nlink,
        "size": st.st_size,
        "uid": st.st_uid,
    }
def reject_unsafe_endpoint(st):
    mode = st.st_mode
    if stat.S_ISLNK(mode):
        raise OSError(errno.ELOOP, "symlink endpoint is not allowed")
    if stat.S_ISREG(mode) and st.st_nlink > 1:
        raise OSError(errno.EPERM, "hardlinked file endpoint is not allowed")
def copy_bytes(source_fd, dest_fd):
    while True:
        chunk = os.read(source_fd, 65536)
        if not chunk:
            break
        view = memoryview(chunk)
        while view:
            written = os.write(dest_fd, view)
            if written <= 0:
                raise OSError(errno.EIO, "short write")
            view = view[written:]
def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError(errno.EIO, "short write")
        view = view[written:]
def link_unsupported(exc):
    unsupported = (errno.EPERM, errno.EOPNOTSUPP, getattr(errno, "ENOTSUP", errno.EOPNOTSUPP))
    return getattr(exc, "errno", None) in unsupported
def link_no_replace(name, new_name, source_fd, target_fd):
    linked = False
    try:
        os.link(name, new_name, src_dir_fd=source_fd, dst_dir_fd=target_fd, follow_symlinks=False)
        linked = True
        os.unlink(name, dir_fd=source_fd)
    except Exception:
        if linked:
            try: os.unlink(new_name, dir_fd=target_fd)
            except FileNotFoundError: pass
        raise
    os.fsync(source_fd)
    if source_fd != target_fd:
        os.fsync(target_fd)
def copy_file_no_replace(source_parent_fd, source_name, target_parent_fd, basename, mode, expected=None, unlink_source=False):
    source_fd = os.open(source_name, READ_FLAGS, dir_fd=source_parent_fd)
    dest_fd = None; success = False; dest_stat = None
    try:
        if expected is not None:
            source_stat = os.fstat(source_fd)
            if source_stat.st_dev != expected.st_dev or source_stat.st_ino != expected.st_ino:
                raise RuntimeError("fs-safe-source-mismatch")
        dest_fd = os.open(basename, WRITE_FLAGS, mode, dir_fd=target_parent_fd)
        copy_bytes(source_fd, dest_fd)
        os.fsync(dest_fd)
        dest_stat = os.fstat(dest_fd)
        success = True
    finally:
        os.close(source_fd)
        if dest_fd is not None:
            os.close(dest_fd)
        if dest_fd is not None and not success:
            try: os.unlink(basename, dir_fd=target_parent_fd)
            except FileNotFoundError: pass
    if unlink_source:
        try:
            os.unlink(source_name, dir_fd=source_parent_fd)
        except Exception:
            try: os.unlink(basename, dir_fd=target_parent_fd)
            except FileNotFoundError: pass
            raise
    return dest_stat
def same_identity(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino
def verify_temp_name(parent_fd, temp_name, expected_stat):
    current_stat = os.lstat(temp_name, dir_fd=parent_fd)
    if stat.S_ISLNK(current_stat.st_mode) or not same_identity(current_stat, expected_stat):
        raise RuntimeError("fs-safe-temp-mismatch")
def verify_committed_temp(parent_fd, basename, expected_stat):
    final_stat = os.lstat(basename, dir_fd=parent_fd)
    if not stat.S_ISLNK(final_stat.st_mode) and same_identity(final_stat, expected_stat):
        return final_stat
    try: os.unlink(basename, dir_fd=parent_fd)
    except FileNotFoundError: pass
    raise RuntimeError("fs-safe-temp-mismatch")
def commit_temp_file(parent_fd, temp_name, basename, overwrite, mode, expected_stat):
    verify_temp_name(parent_fd, temp_name, expected_stat)
    if overwrite:
        os.replace(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        return verify_committed_temp(parent_fd, basename, expected_stat)
    else:
        try:
            os.link(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
            final_stat = verify_committed_temp(parent_fd, basename, expected_stat)
            os.unlink(temp_name, dir_fd=parent_fd)
            return final_stat
        except OSError as exc:
            if not link_unsupported(exc):
                raise
            return copy_file_no_replace(parent_fd, temp_name, parent_fd, basename, mode, expected_stat, True)
def assert_expected_root(root_fd, payload):
    if "rootDev" in payload or "rootIno" in payload:
        root_stat = os.fstat(root_fd)
        if root_stat.st_dev != int(payload["rootDev"]) or root_stat.st_ino != int(payload["rootIno"]):
            raise RuntimeError("fs-safe-root-mismatch")
def stat_path(root_fd, payload):
    relative = payload.get("relativePath", "")
    segments = split_relative(relative)
    if not segments:
        return encode_stat(os.fstat(root_fd))
    parent_fd, basename = parent_and_basename(root_fd, relative)
    try:
        st = os.lstat(basename, dir_fd=parent_fd)
        if payload.get("rejectSymlink", True) and stat.S_ISLNK(st.st_mode):
            raise OSError(errno.ELOOP, "symlink endpoint is not allowed")
        return encode_stat(st)
    finally:
        os.close(parent_fd)
def readdir_path(root_fd, payload):
    dir_fd = walk_dir(root_fd, split_relative(payload.get("relativePath", "")))
    try:
        names = sorted(os.listdir(dir_fd))
        if not payload.get("withFileTypes", False):
            return names
        entries = []
        for name in names:
            st = os.lstat(name, dir_fd=dir_fd)
            entry = encode_stat(st)
            entry["name"] = name
            entries.append(entry)
        return entries
    finally:
        os.close(dir_fd)
def mkdirp_path(root_fd, payload):
    dir_fd = walk_dir(root_fd, split_relative(payload.get("relativePath", "")), mkdir_enabled=True)
    os.close(dir_fd); return None
def remove_tree(parent_fd, basename):
    st = os.lstat(basename, dir_fd=parent_fd)
    if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
        dir_fd = open_dir(basename, dir_fd=parent_fd)
        try:
            for child in os.listdir(dir_fd):
                remove_tree(dir_fd, child)
        finally:
            os.close(dir_fd)
        os.rmdir(basename, dir_fd=parent_fd)
    else:
        os.unlink(basename, dir_fd=parent_fd)
def remove_path(root_fd, payload):
    parent_fd, basename = parent_and_basename(root_fd, payload.get("relativePath", ""))
    try:
        try:
            st = os.lstat(basename, dir_fd=parent_fd)
        except FileNotFoundError:
            if payload.get("force", True):
                return None
            raise
        if stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode):
            if payload.get("recursive", False):
                remove_tree(parent_fd, basename)
            else:
                os.rmdir(basename, dir_fd=parent_fd)
        else:
            os.unlink(basename, dir_fd=parent_fd)
        return None
    finally:
        os.close(parent_fd)

def rename_path(root_fd, payload):
    from_parent_fd, from_base = parent_and_basename(root_fd, payload["from"])
    to_parent_fd, to_base = parent_and_basename(root_fd, payload["to"])
    try:
        from_stat = os.lstat(from_base, dir_fd=from_parent_fd)
        reject_unsafe_endpoint(from_stat)
        overwrite = payload.get("overwrite", True)
        if not overwrite and stat.S_ISREG(from_stat.st_mode):
            try:
                link_no_replace(from_base, to_base, from_parent_fd, to_parent_fd)
            except OSError as exc:
                if not link_unsupported(exc):
                    raise
                copy_file_no_replace(from_parent_fd, from_base, to_parent_fd, to_base, stat.S_IMODE(from_stat.st_mode), from_stat, True)
            return None
        if not overwrite and stat.S_ISDIR(from_stat.st_mode):
            raise RuntimeError("fs-safe-directory-noreplace-unsupported")
        if not overwrite:
            try:
                os.lstat(to_base, dir_fd=to_parent_fd)
                raise FileExistsError(errno.EEXIST, "destination exists", to_base)
            except FileNotFoundError:
                pass
        os.rename(from_base, to_base, src_dir_fd=from_parent_fd, dst_dir_fd=to_parent_fd)
        os.fsync(from_parent_fd)
        if from_parent_fd != to_parent_fd:
            os.fsync(to_parent_fd)
        return None
    finally:
        os.close(from_parent_fd)
        os.close(to_parent_fd)

def create_temp_file(parent_fd, basename, mode):
    prefix = "." + basename + "."
    for _ in range(128):
        candidate = prefix + secrets.token_hex(6) + ".tmp"
        try:
            fd = os.open(candidate, WRITE_FLAGS, mode, dir_fd=parent_fd)
            return candidate, fd
        except FileExistsError:
            continue
    raise RuntimeError("failed to allocate pinned temp file")

def write_path(root_fd, payload):
    parent_fd = walk_dir(root_fd, split_relative(payload.get("relativeParentPath", "")), bool(payload.get("mkdir", True)))
    temp_fd = None
    temp_name = None
    basename = payload["basename"]
    mode = int(payload.get("mode", 0o600))
    overwrite = bool(payload.get("overwrite", True))
    max_bytes = int(payload.get("maxBytes", -1))
    data = base64.b64decode(payload.get("base64", ""))
    try:
        if max_bytes >= 0 and len(data) > max_bytes:
            raise RuntimeError("fs-safe-too-large:%d:%d" % (max_bytes, len(data)))
        if not overwrite:
            try:
                os.lstat(basename, dir_fd=parent_fd)
                raise FileExistsError(errno.EEXIST, "destination exists", basename)
            except FileNotFoundError:
                pass
        temp_name, temp_fd = create_temp_file(parent_fd, basename, mode)
        os.fchmod(temp_fd, mode)
        write_all(temp_fd, data)
        os.fsync(temp_fd)
        temp_stat = os.fstat(temp_fd)
        os.close(temp_fd)
        temp_fd = None
        result_stat = commit_temp_file(parent_fd, temp_name, basename, overwrite, mode, temp_stat)
        temp_name = None
        os.fsync(parent_fd)
        return {"dev": result_stat.st_dev, "ino": result_stat.st_ino}
    finally:
        if temp_fd is not None:
            os.close(temp_fd)
        if temp_name is not None:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        os.close(parent_fd)

def copy_path(root_fd, payload):
    source_fd = os.open(payload["sourcePath"], READ_FLAGS)
    parent_fd = None
    temp_fd = None
    temp_name = None
    try:
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            raise RuntimeError("fs-safe-not-file")
        if source_stat.st_dev != int(payload["sourceDev"]) or source_stat.st_ino != int(payload["sourceIno"]):
            raise RuntimeError("fs-safe-source-mismatch")
        basename = payload["basename"]
        mode = int(payload.get("mode", 0o600))
        overwrite = bool(payload.get("overwrite", True))
        max_bytes = int(payload.get("maxBytes", -1))
        if max_bytes >= 0 and source_stat.st_size > max_bytes:
            raise RuntimeError("fs-safe-too-large:%d:%d" % (max_bytes, source_stat.st_size))
        parent_fd = walk_dir(root_fd, split_relative(payload.get("relativeParentPath", "")), bool(payload.get("mkdir", True)))
        temp_name, temp_fd = create_temp_file(parent_fd, basename, mode)
        os.fchmod(temp_fd, mode)
        written_bytes = 0
        while True:
            chunk = os.read(source_fd, 65536)
            if not chunk:
                break
            written_bytes += len(chunk)
            if max_bytes >= 0 and written_bytes > max_bytes:
                raise RuntimeError("fs-safe-too-large:%d:%d" % (max_bytes, written_bytes))
            view = memoryview(chunk)
            while view:
                written = os.write(temp_fd, view)
                if written <= 0:
                    raise OSError(errno.EIO, "short write")
                view = view[written:]
        os.fsync(temp_fd)
        temp_stat = os.fstat(temp_fd)
        os.close(temp_fd)
        temp_fd = None
        result_stat = commit_temp_file(parent_fd, temp_name, basename, overwrite, mode, temp_stat)
        temp_name = None
        os.fsync(parent_fd)
        return {"dev": result_stat.st_dev, "ino": result_stat.st_ino}
    finally:
        os.close(source_fd)
        if temp_fd is not None:
            os.close(temp_fd)
        if temp_name is not None and parent_fd is not None:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        if parent_fd is not None:
            os.close(parent_fd)

def run_operation(operation, root_path, payload):
    root_fd = open_dir(root_path)
    try:
        assert_expected_root(root_fd, payload)
        if operation == "stat":
            return stat_path(root_fd, payload)
        if operation == "readdir":
            return readdir_path(root_fd, payload)
        if operation == "mkdirp":
            return mkdirp_path(root_fd, payload)
        if operation == "remove":
            return remove_path(root_fd, payload)
        if operation == "rename":
            return rename_path(root_fd, payload)
        if operation == "write":
            return write_path(root_fd, payload)
        if operation == "copy":
            return copy_path(root_fd, payload)
        raise RuntimeError("unknown operation: " + operation)
    finally:
        os.close(root_fd)

for line in sys.stdin:
    try:
        request = json.loads(line)
        result = run_operation(request["operation"], request["rootPath"], request.get("payload") or {})
        response = {"id": request["id"], "ok": True, "result": result}
    except Exception as exc:
        response = {
            "id": request.get("id") if isinstance(locals().get("request"), dict) else None,
            "ok": False,
            "code": exc.__class__.__name__,
            "errno": getattr(exc, "errno", None),
            "message": str(exc),
        }
    print(json.dumps(response, separators=(",", ":")), flush=True)
`;
let nextRequestId = 1;
let worker = null;
const PYTHON_CANDIDATE_DEFAULTS = [
	"/usr/bin/python3",
	"/opt/homebrew/bin/python3",
	"/usr/local/bin/python3"
];
function canExecute(binPath) {
	try {
		fs.accessSync(binPath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function resolvePython() {
	const configured = getFsSafePythonConfig().pythonPath;
	if (configured) return configured;
	for (const candidate of PYTHON_CANDIDATE_DEFAULTS) if (canExecute(candidate)) return candidate;
	return "python3";
}
function assertPinnedHelperSupported() {
	if (process.platform === "win32") throw new FsSafeError("unsupported-platform", "fd-relative pinned filesystem operations are not available on Windows");
	if (getFsSafePythonConfig().mode === "off") throw new FsSafeError("helper-unavailable", "Python helper is disabled");
}
function isSpawnUnavailable(error) {
	if (!(error instanceof Error)) return false;
	const maybeErrno = error;
	return typeof maybeErrno.syscall === "string" && maybeErrno.syscall.startsWith("spawn") && [
		"EACCES",
		"ENOENT",
		"ENOEXEC"
	].includes(maybeErrno.code ?? "");
}
function mapWorkerError(response) {
	const code = typeof response.code === "string" ? response.code : "";
	const errno = typeof response.errno === "number" ? response.errno : void 0;
	const message = typeof response.message === "string" && response.message ? response.message : "pinned helper failed";
	const tooLarge = message.match(/fs-safe-too-large:(\d+):(\d+)/);
	if (tooLarge) {
		const [, limit, got] = tooLarge;
		return new FsSafeError("too-large", `file exceeds limit of ${limit} bytes (got at least ${got})`);
	}
	if (message.includes("fs-safe-not-file")) return new FsSafeError("not-file", "not a file");
	if (message.includes("fs-safe-source-mismatch")) return new FsSafeError("path-mismatch", "source path changed during copy");
	if (message.includes("fs-safe-temp-mismatch")) return new FsSafeError("path-mismatch", "temp path changed during write");
	if (message.includes("fs-safe-root-mismatch")) return new FsSafeError("path-mismatch", "root path changed during operation");
	if (message.includes("fs-safe-directory-noreplace-unsupported")) return new FsSafeError("invalid-path", "directory moves require overwrite: true");
	if (code === "FileNotFoundError" || errno === 2) return new FsSafeError("not-found", "file not found");
	if (code === "FileExistsError" || errno === 17) return new FsSafeError("already-exists", message);
	if (errno === 39) return new FsSafeError("not-empty", "directory is not empty");
	if (errno === 1 || errno === 13 || errno === 21) return new FsSafeError("not-removable", "path is not removable under root");
	if (code === "NotADirectoryError" || code === "OSError" || errno === 20 || errno === 40) return new FsSafeError("path-alias", message);
	return new FsSafeError("helper-failed", message);
}
function rejectPending(error, targetWorker = worker) {
	if (!targetWorker || worker !== targetWorker) return;
	setWorkerRef(targetWorker, false);
	for (const pending of targetWorker.pending.values()) pending.reject(error);
	targetWorker.pending.clear();
	worker = null;
}
function handleWorkerLine(currentWorker, line) {
	if (worker !== currentWorker || !line.trim()) return;
	let decoded;
	try {
		decoded = JSON.parse(line);
	} catch {
		rejectPending(new FsSafeError("helper-failed", `pinned helper returned invalid JSON: ${line}`), currentWorker);
		return;
	}
	if (typeof decoded !== "object" || decoded === null || !("id" in decoded)) {
		rejectPending(new FsSafeError("helper-failed", "pinned helper returned invalid response"), currentWorker);
		return;
	}
	const response = decoded;
	const id = typeof response.id === "number" ? response.id : void 0;
	if (id === void 0) return;
	const pending = currentWorker.pending.get(id);
	if (!pending) return;
	currentWorker.pending.delete(id);
	if (currentWorker.pending.size === 0) setWorkerRef(currentWorker, false);
	if (response.ok === true) {
		pending.resolve(response.result);
		return;
	}
	pending.reject(mapWorkerError(decoded));
}
function getWorker() {
	assertPinnedHelperSupported();
	if (worker) return worker;
	const child = spawn(resolvePython(), [
		"-u",
		"-c",
		PINNED_PYTHON_WORKER_SOURCE
	], { stdio: [
		"pipe",
		"pipe",
		"pipe"
	] });
	const currentWorker = {
		child,
		pending: /* @__PURE__ */ new Map(),
		stderr: "",
		stdoutBuffer: ""
	};
	worker = currentWorker;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		if (worker !== currentWorker) return;
		currentWorker.stdoutBuffer += chunk;
		for (;;) {
			const newline = currentWorker.stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = currentWorker.stdoutBuffer.slice(0, newline);
			currentWorker.stdoutBuffer = currentWorker.stdoutBuffer.slice(newline + 1);
			handleWorkerLine(currentWorker, line);
		}
	});
	child.stderr.on("data", (chunk) => {
		if (worker === currentWorker) currentWorker.stderr = `${currentWorker.stderr}${chunk}`.slice(-4096);
	});
	child.once("error", (error) => {
		rejectPending(isSpawnUnavailable(error) ? new FsSafeError("helper-unavailable", "Python helper is unavailable", { cause: error }) : error instanceof Error ? error : new Error(String(error)), currentWorker);
	});
	child.once("close", (code, signal) => {
		rejectPending(new FsSafeError("helper-failed", currentWorker.stderr.trim() || `pinned helper exited with code ${code ?? "null"} (${signal ?? "?"})`), currentWorker);
	});
	process.once("exit", () => {
		child.kill("SIGTERM");
	});
	setWorkerRef(currentWorker, false);
	return currentWorker;
}
function setRefable(value, ref) {
	if (!value) return;
	value[ref ? "ref" : "unref"]?.();
}
function setWorkerRef(currentWorker, ref) {
	setRefable(currentWorker.child, ref);
	setRefable(currentWorker.child.stdin, ref);
	setRefable(currentWorker.child.stdout, ref);
	setRefable(currentWorker.child.stderr, ref);
}
async function runPinnedPythonOperation(params) {
	const requestId = nextRequestId++;
	const currentWorker = getWorker();
	if (typeof currentWorker.child.stdin?.write !== "function") throw new FsSafeError("helper-unavailable", "Python helper stdin is unavailable");
	setWorkerRef(currentWorker, true);
	return await new Promise((resolve, reject) => {
		currentWorker.pending.set(requestId, {
			reject,
			resolve: (value) => resolve(value)
		});
		const request = JSON.stringify({
			id: requestId,
			operation: params.operation,
			rootPath: params.rootPath,
			payload: params.payload
		});
		currentWorker.child.stdin.write(`${request}\n`, (error) => {
			if (error) {
				currentWorker.pending.delete(requestId);
				if (currentWorker.pending.size === 0) setWorkerRef(currentWorker, false);
				reject(error);
			}
		});
	});
}
function assertPinnedPythonOperationAvailable() {
	if (typeof getWorker().child.stdin?.write !== "function") throw new FsSafeError("helper-unavailable", "Python helper stdin is unavailable");
}
function validatePinnedOperationPayload(payload) {
	if (typeof payload.relativePath === "string") validatePinnedRelativePath(payload.relativePath);
	if (typeof payload.relativeParentPath === "string") validatePinnedRelativePath(payload.relativeParentPath);
	if (typeof payload.from === "string") validatePinnedRelativePath(payload.from);
	if (typeof payload.to === "string") validatePinnedRelativePath(payload.to);
}
function validatePinnedRelativePath(relativePath) {
	if (relativePath.length === 0 || relativePath === ".") return;
	if (relativePath.includes("\0")) throw new FsSafeError("invalid-path", "relative path contains a NUL byte");
	if (relativePath.startsWith("/") || relativePath.startsWith("//") || relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\")) throw new FsSafeError("invalid-path", "relative path must not escape root");
	for (const segment of relativePath.split("/")) if (segment === "..") throw new FsSafeError("invalid-path", "relative path must not contain '..'");
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/pinned-helper.js
async function runPinnedHelper(operation, rootDir, payload) {
	validatePinnedOperationPayload(payload);
	return await runPinnedPythonOperation({
		operation,
		rootPath: rootDir,
		payload
	});
}
async function helperStat(rootDir, relativePath) {
	return await runPinnedHelper("stat", rootDir, { relativePath });
}
async function helperReaddir(rootDir, relativePath, withFileTypes) {
	return await runPinnedHelper("readdir", rootDir, {
		relativePath,
		withFileTypes
	});
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/pinned-path.js
function isPinnedPathHelperSpawnError(error) {
	return canFallbackFromPythonError(error);
}
async function runPinnedPathHelper(params) {
	try {
		await runPinnedHelper(params.operation, params.rootPath, { relativePath: params.relativePath });
	} catch (error) {
		if (error instanceof FsSafeError) throw error;
		throw new FsSafeError("helper-failed", "pinned path helper failed", { cause: error instanceof Error ? error : void 0 });
	}
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/pinned-write.js
function byteLength(input, encoding) {
	return typeof input === "string" ? Buffer.byteLength(input, encoding ?? "utf8") : input.byteLength;
}
function assertSafeBasename(basename) {
	if (!basename || basename === "." || basename === ".." || basename.includes("/") || basename.includes("\0")) throw new FsSafeError("invalid-path", "invalid target path");
}
function assertWithinMaxBytes(bytes, maxBytes) {
	if (maxBytes !== void 0 && bytes > maxBytes) throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`);
}
async function writeStreamToHandle(stream, handle, maxBytes) {
	let bytes = 0;
	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		assertWithinMaxBytes(bytes, maxBytes);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
			if (bytesWritten <= 0) throw new FsSafeError("helper-failed", "fallback stream write made no progress");
			offset += bytesWritten;
		}
	}
}
async function inputToBase64(input, maxBytes) {
	if (input.kind === "buffer") {
		assertWithinMaxBytes(byteLength(input.data, input.encoding), maxBytes);
		return (typeof input.data === "string" ? Buffer.from(input.data, input.encoding ?? "utf8") : input.data).toString("base64");
	}
	const chunks = [];
	let bytes = 0;
	for await (const chunk of input.stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		assertWithinMaxBytes(bytes, maxBytes);
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, bytes).toString("base64");
}
async function runPinnedWriteHelper(params) {
	assertSafeBasename(params.basename);
	validatePinnedOperationPayload({ relativeParentPath: params.relativeParentPath });
	if (getFsSafePythonConfig().mode === "off") return await runPinnedWriteFallback(params);
	if (params.input.kind === "stream") try {
		assertPinnedPythonOperationAvailable();
	} catch (error) {
		if (canFallbackFromPythonError(error)) return await runPinnedWriteFallback(params);
		throw error;
	}
	const payload = {
		base64: await inputToBase64(params.input, params.maxBytes),
		basename: params.basename,
		maxBytes: params.maxBytes ?? -1,
		mkdir: params.mkdir,
		mode: params.mode || 384,
		overwrite: params.overwrite !== false,
		relativeParentPath: params.relativeParentPath,
		...params.rootIdentity ? {
			rootDev: params.rootIdentity.dev,
			rootIno: params.rootIdentity.ino
		} : {}
	};
	try {
		return await runPinnedPythonOperation({
			operation: "write",
			rootPath: params.rootPath,
			payload
		});
	} catch (error) {
		if (canFallbackFromPythonError(error)) return await runPinnedWriteFallback(params);
		throw error;
	}
}
async function runPinnedCopyHelper(params) {
	assertSafeBasename(params.basename);
	validatePinnedOperationPayload({ relativeParentPath: params.relativeParentPath });
	return await runPinnedPythonOperation({
		operation: "copy",
		rootPath: params.rootPath,
		payload: {
			basename: params.basename,
			maxBytes: params.maxBytes ?? -1,
			mkdir: params.mkdir,
			mode: params.mode || 384,
			overwrite: params.overwrite !== false,
			relativeParentPath: params.relativeParentPath,
			...params.rootIdentity ? {
				rootDev: params.rootIdentity.dev,
				rootIno: params.rootIdentity.ino
			} : {},
			sourceDev: params.sourceIdentity.dev,
			sourceIno: params.sourceIdentity.ino,
			sourcePath: params.sourcePath
		}
	});
}
async function runPinnedWriteFallback(params) {
	const parentPath = params.relativeParentPath ? path.join(params.rootPath, ...params.relativeParentPath.split("/")) : params.rootPath;
	if (params.mkdir) await mkdirPathComponentsWithGuards({
		rootReal: params.rootPath,
		targetPath: parentPath
	});
	const parentGuard = params.mkdir ? await createAsyncDirectoryGuard(parentPath) : await createNearestExistingDirectoryGuard(params.rootPath, parentPath);
	const targetPath = path.join(parentPath, params.basename);
	if (params.overwrite === false) {
		let handle = await withAsyncDirectoryGuards([parentGuard], async () => await fs$1.open(targetPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, params.mode), { onPostGuardFailure: async (openedHandle) => {
			await openedHandle.close().catch(() => void 0);
		} });
		let created = true;
		try {
			if (params.input.kind === "buffer") {
				assertWithinMaxBytes(byteLength(params.input.data, params.input.encoding), params.maxBytes);
				if (typeof params.input.data === "string") await handle.writeFile(params.input.data, params.input.encoding ?? "utf8");
				else await handle.writeFile(params.input.data);
			} else await writeStreamToHandle(params.input.stream, handle, params.maxBytes);
			const stat = await handle.stat();
			created = false;
			return {
				dev: stat.dev,
				ino: stat.ino
			};
		} finally {
			await handle.close().catch(() => void 0);
			if (created) await fs$1.rm(targetPath, { force: true }).catch(() => void 0);
		}
	}
	const tempPath = path.join(parentPath, `.${params.basename}.${randomUUID()}.fallback.tmp`);
	const tempFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (process.platform !== "win32" && "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0);
	let handle;
	let tempStat;
	let targetStat;
	let renamed = false;
	try {
		handle = await fs$1.open(tempPath, tempFlags, params.mode);
		if (params.input.kind === "buffer") {
			assertWithinMaxBytes(byteLength(params.input.data, params.input.encoding), params.maxBytes);
			if (typeof params.input.data === "string") await handle.writeFile(params.input.data, params.input.encoding ?? "utf8");
			else await handle.writeFile(params.input.data);
		} else await writeStreamToHandle(params.input.stream, handle, params.maxBytes);
		tempStat = await handle.stat();
		const tempPathStat = await fs$1.lstat(tempPath);
		if (tempPathStat.isSymbolicLink() || !sameFileIdentity(tempPathStat, tempStat)) throw new FsSafeError("path-mismatch", "fallback temp path changed during write");
		const expectedTempStat = tempStat;
		await handle.close().catch(() => void 0);
		handle = void 0;
		await withAsyncDirectoryGuards([parentGuard], async () => {
			await fs$1.rename(tempPath, targetPath);
			renamed = true;
			targetStat = await fs$1.lstat(targetPath);
			if (targetStat.isSymbolicLink() || !sameFileIdentity(targetStat, expectedTempStat)) throw new FsSafeError("path-mismatch", "fallback target changed during write");
		});
	} catch (error) {
		await handle?.close().catch(() => void 0);
		if (!renamed) await fs$1.rm(tempPath, { force: true }).catch(() => void 0);
		throw error;
	}
	if (!targetStat) throw new FsSafeError("path-mismatch", "fallback target was not verified");
	return {
		dev: targetStat.dev,
		ino: targetStat.ino
	};
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/path-policy.js
const PATH_ALIAS_POLICIES = ROOT_PATH_ALIAS_POLICIES;
async function assertNoPathAliasEscape(params) {
	const resolved = await resolveRootPath({
		absolutePath: params.absolutePath,
		rootPath: params.rootPath,
		boundaryLabel: params.boundaryLabel,
		policy: params.policy
	});
	if (params.policy?.allowFinalSymlinkForUnlink === true && resolved.kind === "symlink") return;
	await assertNoHardlinkedFinalPath({
		filePath: resolved.absolutePath,
		root: resolved.rootPath,
		boundaryLabel: params.boundaryLabel,
		allowFinalHardlinkForUnlink: params.policy?.allowFinalHardlinkForUnlink
	});
}
async function assertNoHardlinkedFinalPath(params) {
	if (params.allowFinalHardlinkForUnlink) return;
	let stat;
	try {
		stat = await fs$1.stat(params.filePath);
	} catch (err) {
		if (isNotFoundPathError(err)) return;
		throw err;
	}
	if (!stat.isFile()) return;
	if (stat.nlink > 1) throw new Error(`Hardlinked path is not allowed under ${params.boundaryLabel} (${shortPath(params.root)}): ${shortPath(params.filePath)}`);
}
function shortPath(value) {
	if (value.startsWith(os.homedir())) return `~${value.slice(os.homedir().length)}`;
	return value;
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/path-stat.js
function pathStatFromStats(stat) {
	return {
		dev: Number(stat.dev),
		gid: Number(stat.gid),
		ino: Number(stat.ino),
		isDirectory: stat.isDirectory(),
		isFile: stat.isFile(),
		isSymbolicLink: stat.isSymbolicLink(),
		mode: stat.mode,
		mtimeMs: stat.mtimeMs,
		nlink: stat.nlink,
		size: stat.size,
		uid: stat.uid
	};
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/root-context.js
const ensureTrailingSep = (value) => value.endsWith(path.sep) ? value : value + path.sep;
function assertValidRootRelativePath(relativePath) {
	assertNoNulPathInput(relativePath, "relative path contains a NUL byte");
}
let cachedHomePath;
async function expandRelativePathWithHome(relativePath) {
	const rawHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
	if (cachedHomePath?.raw !== rawHome) {
		let realHome = rawHome;
		try {
			realHome = await fs$1.realpath(rawHome);
		} catch {}
		cachedHomePath = {
			raw: rawHome,
			real: realHome
		};
	}
	return expandHomePrefix(relativePath, { home: cachedHomePath.real });
}
async function resolveRootContext(rootDir) {
	assertNoNulPathInput(rootDir, "root dir contains a NUL byte");
	let rootReal;
	try {
		rootReal = await fs$1.realpath(rootDir);
		if (!(await fs$1.stat(rootReal)).isDirectory()) throw new FsSafeError("invalid-path", "root dir is not a directory");
	} catch (err) {
		if (err instanceof FsSafeError) throw err;
		if (isNotFoundPathError(err)) throw new FsSafeError("not-found", "root dir not found");
		throw err;
	}
	return {
		rootDir: path.resolve(rootDir),
		rootReal,
		rootWithSep: ensureTrailingSep(rootReal)
	};
}
async function resolvePathInRoot(root, relativePath) {
	assertValidRootRelativePath(relativePath);
	const expanded = await expandRelativePathWithHome(relativePath);
	const resolved = path.resolve(root.rootWithSep, expanded);
	if (!isPathInside(root.rootWithSep, resolved)) throw new FsSafeError("outside-workspace", "file is outside workspace root");
	return {
		rootReal: root.rootReal,
		rootWithSep: root.rootWithSep,
		resolved
	};
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/root-errors.js
function isAlreadyExistsError(error) {
	return hasNodeErrorCode(error, "EEXIST") || /File exists|EEXIST/i.test(String(error));
}
function normalizePinnedWriteError(error) {
	if (error instanceof FsSafeError) return error;
	return new FsSafeError("invalid-path", "path is not a regular file under root", { cause: error instanceof Error ? error : void 0 });
}
function normalizePinnedPathError(error) {
	if (error instanceof FsSafeError) return error;
	return new FsSafeError("path-alias", "path is not under root", { cause: error instanceof Error ? error : void 0 });
}
function getFsSafeTestHooks() {}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/root-impl.js
function logWarn(message) {
	if (process.env.FS_SAFE_DEBUG_WARNINGS === "1") console.warn(message);
}
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in constants;
const NONBLOCK_OPEN_FLAG = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
const OPEN_READ_FLAGS = constants.O_RDONLY | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_READ_NONBLOCK_FLAGS = OPEN_READ_FLAGS | NONBLOCK_OPEN_FLAG;
const OPEN_READ_FOLLOW_FLAGS = constants.O_RDONLY;
const OPEN_READ_FOLLOW_NONBLOCK_FLAGS = OPEN_READ_FOLLOW_FLAGS | NONBLOCK_OPEN_FLAG;
const OPEN_WRITE_EXISTING_FLAGS = constants.O_WRONLY | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_WRITE_CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_APPEND_EXISTING_FLAGS = constants.O_RDWR | constants.O_APPEND | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const OPEN_APPEND_CREATE_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (SUPPORTS_NOFOLLOW ? constants.O_NOFOLLOW : 0);
const DEFAULT_ROOT_MAX_BYTES = 16 * 1024 * 1024;
function closeHandleForDispose(handle) {
	return handle.close().catch(() => void 0);
}
function openResult(params) {
	return {
		handle: params.handle,
		realPath: params.realPath,
		stat: params.stat,
		[Symbol.asyncDispose]: async () => {
			await closeHandleForDispose(params.handle);
		}
	};
}
async function openVerifiedLocalFile(filePath, options) {
	try {
		if ((await fs$1.lstat(filePath)).isDirectory()) throw new FsSafeError("not-file", "not a file");
		await void 0;
	} catch (err) {
		if (err instanceof FsSafeError) throw err;
	}
	let handle;
	try {
		const openFlags = options?.symlinks === "follow-within-root" ? options?.nonBlockingRead ? OPEN_READ_FOLLOW_NONBLOCK_FLAGS : OPEN_READ_FOLLOW_FLAGS : options?.nonBlockingRead ? OPEN_READ_NONBLOCK_FLAGS : OPEN_READ_FLAGS;
		await void 0;
		handle = await fs$1.open(filePath, openFlags);
		try {
			await void 0;
		} catch (err) {
			await handle.close().catch(() => {});
			throw err;
		}
	} catch (err) {
		if (isNotFoundPathError(err)) throw new FsSafeError("not-found", "file not found");
		if (isSymlinkOpenError(err)) throw new FsSafeError("symlink", "symlink open blocked", { cause: err });
		if (hasNodeErrorCode(err, "EISDIR")) throw new FsSafeError("not-file", "not a file");
		throw err;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new FsSafeError("not-file", "not a file");
		if (options?.hardlinks === "reject" && stat.nlink > 1) throw new FsSafeError("hardlink", "hardlinked path not allowed");
		if (options?.symlinks === "follow-within-root") {
			if (!sameFileIdentity(stat, await fs$1.stat(filePath))) throw new FsSafeError("path-mismatch", "path changed during read");
		} else {
			const pathStat = await fs$1.lstat(filePath);
			if (pathStat.isSymbolicLink()) throw new FsSafeError("symlink", "symlink not allowed");
			if (!sameFileIdentity(stat, pathStat)) throw new FsSafeError("path-mismatch", "path changed during read");
		}
		const realPath = await resolveOpenedFileRealPathForHandle(handle, filePath);
		const realStat = await fs$1.stat(realPath);
		if (options?.hardlinks === "reject" && realStat.nlink > 1) throw new FsSafeError("hardlink", "hardlinked path not allowed");
		if (!sameFileIdentity(stat, realStat)) throw new FsSafeError("path-mismatch", "path mismatch");
		return openResult({
			handle,
			realPath,
			stat
		});
	} catch (err) {
		await handle.close().catch(() => {});
		if (err instanceof FsSafeError) throw err;
		if (isNotFoundPathError(err)) throw new FsSafeError("not-found", "file not found");
		throw err;
	}
}
var RootHandle = class {
	rootDir;
	rootReal;
	rootWithSep;
	defaults;
	constructor(context, defaults = {}) {
		this.rootDir = context.rootDir;
		this.rootReal = context.rootReal;
		this.rootWithSep = context.rootWithSep;
		this.defaults = defaults;
	}
	get context() {
		return {
			rootDir: this.rootDir,
			rootReal: this.rootReal,
			rootWithSep: this.rootWithSep
		};
	}
	async resolve(relativePath) {
		return (await resolvePathInRoot(this.context, relativePath)).resolved;
	}
	async open(relativePath, options = {}) {
		return await openFileInRoot(this.context, {
			relativePath,
			...readDefaults(this.defaults),
			...options
		});
	}
	async read(relativePath, options = {}) {
		return await readFileInRoot(this.context, {
			relativePath,
			...readDefaults(this.defaults),
			...options
		});
	}
	async readBytes(relativePath, options = {}) {
		return (await this.read(relativePath, options)).buffer;
	}
	async readText(relativePath, options = {}) {
		const { encoding = "utf8", ...readOptions } = options;
		return (await this.read(relativePath, readOptions)).buffer.toString(encoding);
	}
	async readJson(relativePath, options = {}) {
		return JSON.parse(await this.readText(relativePath, options));
	}
	async readAbsolute(filePath, options = {}) {
		return await readPathInRoot(this.context, {
			filePath,
			...readDefaults(this.defaults),
			...options
		});
	}
	reader(options = {}) {
		return async (filePath) => {
			return (await this.readAbsolute(filePath, options)).buffer;
		};
	}
	async openWritable(relativePath, options = {}) {
		const writeMode = options.writeMode ?? "replace";
		return await openWritableFileInRoot(this.context, {
			relativePath,
			mkdir: this.defaults.mkdir,
			mode: this.defaults.mode,
			...options,
			append: writeMode === "append",
			truncateExisting: writeMode === "replace"
		});
	}
	async append(relativePath, data, options = {}) {
		await appendFileInRoot(this.context, {
			relativePath,
			data,
			mkdir: this.defaults.mkdir,
			mode: this.defaults.mode,
			...options
		});
	}
	async remove(relativePath) {
		assertValidRootRelativePath(relativePath);
		await removePathInRoot(this.context, relativePath);
	}
	async mkdir(relativePath) {
		assertValidRootRelativePath(relativePath);
		await mkdirPathInRoot(this.context, { relativePath });
	}
	async ensureRoot() {
		await mkdirPathInRoot(this.context, {
			relativePath: "",
			allowRoot: true
		});
	}
	async write(relativePath, data, options = {}) {
		await writeFileInRoot(this.context, {
			relativePath,
			data,
			mkdir: this.defaults.mkdir,
			mode: this.defaults.mode,
			...options
		});
	}
	async create(relativePath, data, options = {}) {
		await writeFileInRoot(this.context, {
			relativePath,
			data,
			mkdir: this.defaults.mkdir,
			mode: this.defaults.mode,
			...options,
			overwrite: false
		});
	}
	async writeJson(relativePath, data, options = {}) {
		const { replacer, space, trailingNewline = true, ...writeOptions } = options;
		const json = stringifyJsonDocument(data, replacer, space);
		await this.write(relativePath, trailingNewline ? `${json}\n` : json, writeOptions);
	}
	async createJson(relativePath, data, options = {}) {
		const { replacer, space, trailingNewline = true, ...writeOptions } = options;
		const json = stringifyJsonDocument(data, replacer, space);
		await this.create(relativePath, trailingNewline ? `${json}\n` : json, writeOptions);
	}
	async copyIn(relativePath, sourcePath, options = {}) {
		assertValidRootRelativePath(relativePath);
		await copyFileInRoot(this.context, {
			sourcePath,
			relativePath,
			maxBytes: this.defaults.maxBytes,
			mkdir: this.defaults.mkdir,
			mode: this.defaults.mode,
			...options
		});
	}
	async exists(relativePath) {
		try {
			await this.stat(relativePath);
			return true;
		} catch (err) {
			if (err instanceof FsSafeError && err.code === "not-found") return false;
			throw err;
		}
	}
	async stat(relativePath) {
		assertValidRootRelativePath(relativePath);
		try {
			return await helperStat(this.rootReal, relativePath);
		} catch (error) {
			if (canFallbackFromPythonError(error)) return await statPathFallback(this.context, relativePath);
			throw error;
		}
	}
	async list(relativePath, options = {}) {
		assertValidRootRelativePath(relativePath);
		try {
			return options.withFileTypes === true ? await helperReaddir(this.rootReal, relativePath, true) : await helperReaddir(this.rootReal, relativePath, false);
		} catch (error) {
			if (canFallbackFromPythonError(error)) return await listPathFallback(this.context, relativePath, options.withFileTypes === true);
			throw error;
		}
	}
	async move(fromRelative, toRelative, options = {}) {
		assertValidRootRelativePath(fromRelative);
		assertValidRootRelativePath(toRelative);
		try {
			await runPinnedHelper("rename", this.rootReal, {
				from: fromRelative,
				overwrite: options.overwrite ?? false,
				to: toRelative
			});
		} catch (error) {
			if (canFallbackFromPythonError(error)) {
				await movePathFallback(this.context, {
					fromRelative,
					overwrite: options.overwrite ?? false,
					toRelative
				});
				return;
			}
			throw error;
		}
	}
};
function readDefaults(defaults) {
	return {
		hardlinks: defaults.hardlinks,
		maxBytes: defaults.maxBytes ?? 16777216,
		nonBlockingRead: defaults.nonBlockingRead,
		symlinks: defaults.symlinks
	};
}
async function root(rootDir, defaults = {}) {
	return new RootHandle(await resolveRootContext(rootDir), defaults);
}
async function openFileInRoot(root, params) {
	const { rootWithSep, resolved } = await resolvePathInRoot(root, params.relativePath);
	let opened;
	try {
		opened = await openVerifiedLocalFile(resolved, {
			nonBlockingRead: params.nonBlockingRead,
			symlinks: params.symlinks
		});
	} catch (err) {
		if (err instanceof FsSafeError) throw err;
		throw err;
	}
	if (params.hardlinks !== "allow" && opened.stat.nlink > 1) {
		await opened.handle.close().catch(() => {});
		throw new FsSafeError("hardlink", "hardlinked path not allowed");
	}
	if (!isPathInside(rootWithSep, opened.realPath)) {
		await opened.handle.close().catch(() => {});
		throw new FsSafeError("outside-workspace", "file is outside workspace root");
	}
	return opened;
}
async function readFileInRoot(root, params) {
	const opened = await openFileInRoot(root, params);
	try {
		return await readOpenedFileSafely({
			opened,
			maxBytes: params.maxBytes
		});
	} finally {
		await opened.handle.close().catch(() => {});
	}
}
async function readPathInRoot(root, params) {
	const rootDir = root.rootDir;
	const candidatePath = path.isAbsolute(params.filePath) ? path.resolve(params.filePath) : path.resolve(rootDir, params.filePath);
	return await readFileInRoot(root, {
		relativePath: path.relative(rootDir, candidatePath),
		hardlinks: params.hardlinks,
		maxBytes: params.maxBytes,
		nonBlockingRead: params.nonBlockingRead,
		symlinks: params.symlinks
	});
}
async function readLocalFileSafely(params) {
	const opened = await openLocalFileSafely({ filePath: params.filePath });
	try {
		return await readOpenedFileSafely({
			opened,
			maxBytes: params.maxBytes
		});
	} finally {
		await opened.handle.close().catch(() => {});
	}
}
async function openLocalFileSafely(params) {
	assertNoNulPathInput(params.filePath, "file path contains a NUL byte");
	return await openVerifiedLocalFile(params.filePath);
}
async function readOpenedFileSafely(params) {
	if (params.maxBytes !== void 0 && params.opened.stat.size > params.maxBytes) throw new FsSafeError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${params.opened.stat.size})`);
	const buffer = await params.opened.handle.readFile();
	if (params.maxBytes !== void 0 && buffer.byteLength > params.maxBytes) throw new FsSafeError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${buffer.byteLength})`);
	return {
		buffer,
		realPath: params.opened.realPath,
		stat: params.opened.stat
	};
}
function emitWriteBoundaryWarning(reason) {
	logWarn(`security: fs-safe write boundary warning (${reason})`);
}
function buildAtomicWriteTempPath(targetPath) {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	return path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
}
function rootWriteQueueKey(root, relativePath) {
	return `${root.rootReal}\0${relativePath}`;
}
async function writeTempFileForAtomicReplace(params) {
	const tempHandle = await fs$1.open(params.tempPath, OPEN_WRITE_CREATE_FLAGS, params.mode);
	try {
		if (typeof params.data === "string") await tempHandle.writeFile(params.data, params.encoding ?? "utf8");
		else await tempHandle.writeFile(params.data);
		return await tempHandle.stat();
	} finally {
		await tempHandle.close().catch(() => {});
	}
}
async function verifyAtomicWriteResult(params) {
	const opened = await openVerifiedLocalFile(params.targetPath, { hardlinks: "reject" });
	try {
		if (!sameFileIdentity(opened.stat, params.expectedIdentity)) throw new FsSafeError("path-mismatch", "path changed during write");
		if (!isPathInside(params.root.rootWithSep, opened.realPath)) throw new FsSafeError("outside-workspace", "file is outside workspace root");
	} finally {
		await opened.handle.close().catch(() => {});
	}
}
async function resolveOpenedFileRealPathForHandle(handle, ioPath) {
	const handleStat = await handle.stat();
	const fdCandidates = process.platform === "linux" ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`] : process.platform === "win32" ? [] : [`/dev/fd/${handle.fd}`];
	for (const fdPath of fdCandidates) try {
		const fdRealPath = await fs$1.realpath(fdPath);
		if (sameFileIdentity(handleStat, await fs$1.stat(fdRealPath))) return fdRealPath;
	} catch {}
	try {
		const ioRealPath = await fs$1.realpath(ioPath);
		if (sameFileIdentity(handleStat, await fs$1.stat(ioRealPath))) return ioRealPath;
	} catch (err) {
		if (!isNotFoundPathError(err)) throw err;
	}
	const parentResolved = await resolveOpenedFileRealPathFromParent(handleStat, ioPath);
	if (parentResolved) return parentResolved;
	throw new FsSafeError("path-mismatch", "unable to resolve opened file path");
}
async function resolveOpenedFileRealPathFromParent(handleStat, ioPath) {
	let parentReal;
	try {
		parentReal = await fs$1.realpath(path.dirname(ioPath));
	} catch (err) {
		if (isNotFoundPathError(err)) return null;
		throw err;
	}
	let entries;
	try {
		entries = await fs$1.readdir(parentReal);
	} catch (err) {
		if (isNotFoundPathError(err)) return null;
		throw err;
	}
	for (const entry of entries.toSorted()) {
		const candidatePath = path.join(parentReal, entry);
		try {
			const candidateStat = await fs$1.lstat(candidatePath);
			if (candidateStat.isFile() && sameFileIdentity(handleStat, candidateStat)) return await fs$1.realpath(candidatePath);
		} catch (err) {
			if (!isNotFoundPathError(err)) throw err;
		}
	}
	return null;
}
async function openWritableFileInRoot(root, params) {
	const { rootReal, rootWithSep, resolved } = await resolvePathInRoot(root, params.relativePath);
	try {
		await assertNoPathAliasEscape({
			absolutePath: resolved,
			rootPath: rootReal,
			boundaryLabel: "root"
		});
	} catch (err) {
		throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
	}
	if (params.mkdir !== false) await withAsyncDirectoryGuards([await createNearestExistingDirectoryGuard(rootReal, path.dirname(resolved))], async () => {
		await fs$1.mkdir(path.dirname(resolved), { recursive: true });
	});
	let ioPath = resolved;
	try {
		const resolvedRealPath = await fs$1.realpath(resolved);
		if (!isPathInside(rootWithSep, resolvedRealPath)) throw new FsSafeError("outside-workspace", "file is outside workspace root");
		ioPath = resolvedRealPath;
	} catch (err) {
		if (err instanceof FsSafeError) throw err;
		if (!isNotFoundPathError(err)) throw err;
	}
	const mode = params.mode ?? 384;
	let handle;
	let createdForWrite = false;
	const existingFlags = params.append ? OPEN_APPEND_EXISTING_FLAGS : OPEN_WRITE_EXISTING_FLAGS;
	const createFlags = params.append ? OPEN_APPEND_CREATE_FLAGS : OPEN_WRITE_CREATE_FLAGS;
	try {
		try {
			handle = await fs$1.open(ioPath, existingFlags, mode);
		} catch (err) {
			if (!isNotFoundPathError(err)) throw err;
			handle = await fs$1.open(ioPath, createFlags, mode);
			createdForWrite = true;
		}
	} catch (err) {
		if (isNotFoundPathError(err)) throw new FsSafeError("not-found", "file not found");
		if (isSymlinkOpenError(err)) throw new FsSafeError("symlink", "symlink open blocked", { cause: err });
		if (hasNodeErrorCode(err, "EISDIR")) throw new FsSafeError("not-file", "not a file", { cause: err });
		throw err;
	}
	let realPathForCleanup = null;
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new FsSafeError("invalid-path", "path is not a regular file under root");
		if (stat.nlink > 1) throw new FsSafeError("hardlink", "hardlinked path not allowed");
		try {
			const lstat = await fs$1.lstat(ioPath);
			if (lstat.isSymbolicLink() || !lstat.isFile()) throw new FsSafeError(lstat.isSymbolicLink() ? "symlink" : "not-file", "path is not a regular file under root");
			if (!sameFileIdentity(stat, lstat)) throw new FsSafeError("path-mismatch", "path changed during write");
		} catch (err) {
			if (!isNotFoundPathError(err)) throw err;
		}
		const realPath = await resolveOpenedFileRealPathForHandle(handle, ioPath);
		realPathForCleanup = realPath;
		const realStat = await fs$1.stat(realPath);
		if (!sameFileIdentity(stat, realStat)) throw new FsSafeError("path-mismatch", "path mismatch");
		if (realStat.nlink > 1) throw new FsSafeError("hardlink", "hardlinked path not allowed");
		if (!isPathInside(rootWithSep, realPath)) throw new FsSafeError("outside-workspace", "file is outside workspace root");
		if (params.append !== true && params.truncateExisting !== false && !createdForWrite) await handle.truncate(0);
		return {
			handle,
			createdForWrite,
			realPath,
			stat,
			[Symbol.asyncDispose]: async () => {
				await closeHandleForDispose(handle);
			}
		};
	} catch (err) {
		const cleanupCreatedPath = createdForWrite && err instanceof FsSafeError;
		const cleanupPath = realPathForCleanup ?? ioPath;
		await handle.close().catch(() => {});
		if (cleanupCreatedPath) await fs$1.rm(cleanupPath, { force: true }).catch(() => {});
		throw err;
	}
}
async function appendFileInRoot(root, params) {
	const target = await openWritableFileInRoot(root, {
		relativePath: params.relativePath,
		mkdir: params.mkdir,
		mode: params.mode,
		truncateExisting: false,
		append: true
	});
	try {
		let prefix = "";
		if (params.prependNewlineIfNeeded === true && !target.createdForWrite && target.stat.size > 0 && (typeof params.data === "string" && !params.data.startsWith("\n") || Buffer.isBuffer(params.data) && params.data.length > 0 && params.data[0] !== 10)) {
			const lastByte = Buffer.alloc(1);
			const { bytesRead } = await target.handle.read(lastByte, 0, 1, target.stat.size - 1);
			if (bytesRead === 1 && lastByte[0] !== 10) prefix = "\n";
		}
		if (typeof params.data === "string") {
			await target.handle.appendFile(`${prefix}${params.data}`, params.encoding ?? "utf8");
			return;
		}
		const payload = prefix.length > 0 ? Buffer.concat([Buffer.from(prefix, "utf8"), params.data]) : params.data;
		await target.handle.appendFile(payload);
	} finally {
		await target.handle.close().catch(() => {});
	}
}
async function removePathInRoot(root, relativePath) {
	const resolved = await resolvePinnedRemovePathInRoot(root, relativePath);
	if (process.platform === "win32") {
		await removePathFallback(resolved);
		return;
	}
	try {
		await runPinnedPathHelper({
			operation: "remove",
			rootPath: resolved.rootReal,
			relativePath: resolved.relativePosix
		});
	} catch (error) {
		if (isPinnedPathHelperSpawnError(error)) {
			await removePathFallback(resolved);
			return;
		}
		throw normalizePinnedPathError(error);
	}
}
async function mkdirPathInRoot(root, params) {
	const resolved = await resolvePinnedPathInRoot(root, params);
	if (process.platform === "win32") {
		await mkdirPathFallback(resolved);
		return;
	}
	try {
		await runPinnedPathHelper({
			operation: "mkdirp",
			rootPath: resolved.rootReal,
			relativePath: resolved.relativePosix
		});
	} catch (error) {
		if (isPinnedPathHelperSpawnError(error)) {
			await mkdirPathFallback(resolved);
			return;
		}
		throw normalizePinnedPathError(error);
	}
}
async function writeFileInRoot(root, params) {
	if (process.platform === "win32") {
		await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
			await writeFileFallback(root, params);
		});
		return;
	}
	const pinned = await resolvePinnedWriteTargetInRoot(root, params.relativePath, params.mode);
	await serializePathWrite(pinned.targetPath, async () => {
		let identity;
		try {
			identity = await runPinnedWriteHelper({
				rootPath: pinned.rootReal,
				relativeParentPath: pinned.relativeParentPath,
				basename: pinned.basename,
				mkdir: params.mkdir !== false,
				mode: params.mode ?? pinned.mode,
				overwrite: params.overwrite,
				input: {
					kind: "buffer",
					data: params.data,
					encoding: params.encoding
				}
			});
		} catch (error) {
			if (params.overwrite === false && isAlreadyExistsError(error)) throw new FsSafeError("already-exists", "file already exists", { cause: error instanceof Error ? error : void 0 });
			throw normalizePinnedWriteError(error);
		}
		try {
			await verifyAtomicWriteResult({
				root,
				targetPath: pinned.targetPath,
				expectedIdentity: identity
			});
		} catch (err) {
			emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
			throw err;
		}
	});
}
async function copyFileInRoot(root, params) {
	assertValidRootRelativePath(params.relativePath);
	assertNoNulPathInput(params.sourcePath, "source path contains a NUL byte");
	const source = await openVerifiedLocalFile(params.sourcePath, { hardlinks: params.sourceHardlinks });
	if (params.maxBytes !== void 0 && source.stat.size > params.maxBytes) {
		await source.handle.close().catch(() => {});
		throw new FsSafeError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${source.stat.size})`);
	}
	try {
		if (process.platform === "win32") {
			await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
				await copyFileFallback(root, params, source);
			});
			return;
		}
		const pinned = await resolvePinnedWriteTargetInRoot(root, params.relativePath, params.mode);
		await serializePathWrite(pinned.targetPath, async () => {
			let identity;
			try {
				if (getFsSafePythonConfig().mode === "off") {
					await copyFileFallback(root, params, source);
					return;
				}
				identity = await runPinnedCopyHelper({
					rootPath: pinned.rootReal,
					relativeParentPath: pinned.relativeParentPath,
					basename: pinned.basename,
					mkdir: params.mkdir !== false,
					mode: pinned.mode,
					overwrite: true,
					maxBytes: params.maxBytes,
					sourcePath: source.realPath,
					sourceIdentity: {
						dev: source.stat.dev,
						ino: source.stat.ino
					}
				});
			} catch (error) {
				if (canFallbackFromPythonError(error)) {
					await copyFileFallback(root, params, source);
					return;
				}
				throw normalizePinnedWriteError(error);
			}
			try {
				await verifyAtomicWriteResult({
					root,
					targetPath: pinned.targetPath,
					expectedIdentity: identity
				});
			} catch (err) {
				emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
				throw err;
			}
		});
	} finally {
		await source.handle.close().catch(() => {});
	}
}
async function resolvePinnedWriteTargetInRoot(root, relativePath, requestedMode) {
	const { rootReal, rootWithSep, resolved } = await resolvePathInRoot(root, relativePath);
	try {
		await assertNoPathAliasEscape({
			absolutePath: resolved,
			rootPath: rootReal,
			boundaryLabel: "root"
		});
	} catch (err) {
		throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
	}
	const relativeResolved = path.relative(rootReal, resolved);
	if (path.isAbsolute(relativeResolved)) throw new FsSafeError("outside-workspace", "file is outside workspace root");
	const relativePosix = relativeResolved ? relativeResolved.split(path.sep).join(path.posix.sep) : "";
	const basename = path.posix.basename(relativePosix);
	if (!basename || basename === "." || basename === "/") throw new FsSafeError("invalid-path", "invalid target path");
	let mode = requestedMode ?? 384;
	try {
		const opened = await openFileInRoot(root, {
			relativePath,
			hardlinks: "reject",
			nonBlockingRead: true
		});
		try {
			mode = requestedMode ?? opened.stat.mode & 511;
			if (!isPathInside(rootWithSep, opened.realPath)) throw new FsSafeError("outside-workspace", "file is outside workspace root");
		} finally {
			await opened.handle.close().catch(() => {});
		}
	} catch (err) {
		if (!(err instanceof FsSafeError) || err.code !== "not-found") throw err;
	}
	return {
		rootReal,
		targetPath: resolved,
		relativeParentPath: path.posix.dirname(relativePosix) === "." ? "" : path.posix.dirname(relativePosix),
		basename,
		mode: mode || 384
	};
}
async function resolvePinnedPathInRoot(root, params) {
	return await resolvePinnedOperationPathInRoot(root, {
		allowRoot: params.allowRoot,
		relativePath: params.relativePath,
		policy: PATH_ALIAS_POLICIES.strict
	});
}
async function resolvePinnedRemovePathInRoot(root, relativePath) {
	return await resolvePinnedOperationPathInRoot(root, {
		relativePath,
		policy: PATH_ALIAS_POLICIES.unlinkTarget
	});
}
async function resolvePinnedOperationPathInRoot(root, params) {
	const resolved = await resolvePinnedRootPathInRoot(root, {
		relativePath: params.relativePath,
		policy: params.policy
	});
	const relativeResolved = path.relative(resolved.rootReal, resolved.canonicalPath);
	if ((relativeResolved === "" || relativeResolved === ".") && params.allowRoot === true) return {
		rootReal: resolved.rootReal,
		resolved: resolved.canonicalPath,
		relativePosix: ""
	};
	const firstSegment = relativeResolved.split(path.sep)[0];
	if (relativeResolved === "" || relativeResolved === "." || firstSegment === ".." || path.isAbsolute(relativeResolved)) throw new FsSafeError("outside-workspace", "file is outside workspace root");
	const relativePosix = relativeResolved.split(path.sep).join(path.posix.sep);
	if (!isPathInside(resolved.rootWithSep, resolved.canonicalPath)) throw new FsSafeError("outside-workspace", "file is outside workspace root");
	return {
		rootReal: resolved.rootReal,
		resolved: resolved.canonicalPath,
		relativePosix
	};
}
async function resolvePinnedRootPathInRoot(root, params) {
	const rootReal = root.rootReal;
	let resolved;
	try {
		resolved = await resolveRootPath({
			absolutePath: path.resolve(rootReal, await expandRelativePathWithHome(params.relativePath)),
			rootPath: rootReal,
			rootCanonicalPath: rootReal,
			boundaryLabel: "root",
			policy: params.policy
		});
	} catch (err) {
		throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
	}
	const rootWithSep = ensureTrailingSep(resolved.rootCanonicalPath);
	return {
		rootReal: resolved.rootCanonicalPath,
		rootWithSep,
		canonicalPath: resolved.canonicalPath
	};
}
async function removePathFallback(resolved) {
	const guard = await createAsyncDirectoryGuard(path.dirname(resolved.resolved));
	await void 0;
	await assertAsyncDirectoryGuard(guard);
	await ((await fs$1.lstat(resolved.resolved)).isDirectory() ? fs$1.rmdir(resolved.resolved) : fs$1.rm(resolved.resolved));
	await assertAsyncDirectoryGuard(guard).catch(() => void 0);
}
async function mkdirPathFallback(resolved) {
	await mkdirPathComponentsWithGuards({
		rootReal: resolved.rootReal,
		targetPath: resolved.resolved,
		beforeComponent: async (componentPath) => await void 0
	});
}
async function statPathFallback(root, relativePath) {
	const resolved = await resolvePinnedPathInRoot(root, {
		relativePath,
		allowRoot: true
	});
	try {
		return pathStatFromStats(await fs$1.lstat(resolved.resolved));
	} catch (error) {
		if (isNotFoundPathError(error)) throw new FsSafeError("not-found", "file not found", { cause: error instanceof Error ? error : void 0 });
		throw error;
	}
}
async function listPathFallback(root, relativePath, withFileTypes) {
	const resolved = await resolvePinnedPathInRoot(root, {
		relativePath,
		allowRoot: true
	});
	try {
		const sortedNames = (await fs$1.readdir(resolved.resolved)).toSorted();
		if (!withFileTypes) return sortedNames;
		const entries = [];
		for (const name of sortedNames) entries.push({
			name,
			...pathStatFromStats(await fs$1.lstat(path.join(resolved.resolved, name)))
		});
		return entries;
	} catch (error) {
		if (isNotFoundPathError(error)) throw new FsSafeError("not-found", "directory not found", { cause: error instanceof Error ? error : void 0 });
		throw error;
	}
}
async function movePathFallback(root, params) {
	const source = await resolvePathInRoot(root, params.fromRelative);
	await resolvePinnedRootPathInRoot(root, {
		relativePath: params.fromRelative,
		policy: PATH_ALIAS_POLICIES.strict
	});
	const target = await resolvePathInRoot(root, params.toRelative);
	await resolvePinnedRootPathInRoot(root, {
		relativePath: params.toRelative,
		policy: PATH_ALIAS_POLICIES.unlinkTarget
	});
	try {
		await assertNoPathAliasEscape({
			absolutePath: target.resolved,
			rootPath: target.rootReal,
			boundaryLabel: "root"
		});
	} catch (error) {
		throw new FsSafeError("path-alias", "path alias escape blocked", { cause: error instanceof Error ? error : void 0 });
	}
	let sourceStat;
	try {
		sourceStat = await fs$1.lstat(source.resolved);
	} catch (error) {
		if (isNotFoundPathError(error)) throw new FsSafeError("not-found", "file not found", { cause: error instanceof Error ? error : void 0 });
		throw error;
	}
	if (sourceStat.isSymbolicLink()) throw new FsSafeError("symlink", "symlink not allowed");
	if (sourceStat.isFile() && sourceStat.nlink > 1) throw new FsSafeError("hardlink", "hardlinked path not allowed");
	if (!params.overwrite && sourceStat.isDirectory()) throw new FsSafeError("invalid-path", "directory moves require overwrite: true");
	if (!params.overwrite) try {
		await fs$1.lstat(target.resolved);
		throw new FsSafeError("already-exists", "destination exists");
	} catch (error) {
		if (error instanceof FsSafeError) throw error;
		if (!isNotFoundPathError(error)) throw error;
	}
	const sourceParentGuard = await createAsyncDirectoryGuard(path.dirname(source.resolved));
	const targetParentGuard = await createNearestExistingDirectoryGuard(target.rootReal, path.dirname(target.resolved));
	await void 0;
	await assertAsyncDirectoryGuard(sourceParentGuard);
	await assertAsyncDirectoryGuard(targetParentGuard);
	try {
		await fs$1.rename(source.resolved, target.resolved);
	} catch (error) {
		if (isNotFoundPathError(error)) throw new FsSafeError("not-found", "file not found", { cause: error instanceof Error ? error : void 0 });
		if (hasNodeErrorCode(error, "EEXIST")) throw new FsSafeError("already-exists", "destination exists", { cause: error instanceof Error ? error : void 0 });
		throw error;
	}
	await assertAsyncDirectoryGuard(targetParentGuard).catch(() => void 0);
}
async function writeFileFallback(root, params) {
	if (params.overwrite === false) {
		await writeMissingFileFallback(root, params);
		return;
	}
	const target = await openWritableFileInRoot(root, {
		relativePath: params.relativePath,
		mkdir: params.mkdir,
		mode: params.mode,
		truncateExisting: false
	});
	const destinationPath = target.realPath;
	const mode = params.mode ?? target.stat.mode & 511;
	await target.handle.close().catch(() => {});
	const destinationGuard = await createAsyncDirectoryGuard(path.dirname(destinationPath));
	let tempPath = null;
	let unregisterTempPath = null;
	try {
		tempPath = buildAtomicWriteTempPath(destinationPath);
		unregisterTempPath = registerTempPathForExit(tempPath);
		const writtenStat = await writeTempFileForAtomicReplace({
			tempPath,
			data: params.data,
			encoding: params.encoding,
			mode: mode || 384
		});
		const commitTempPath = tempPath;
		await withAsyncDirectoryGuards([destinationGuard], async () => {
			await fs$1.rename(commitTempPath, destinationPath);
		});
		tempPath = null;
		unregisterTempPath();
		unregisterTempPath = null;
		try {
			await verifyAtomicWriteResult({
				root,
				targetPath: destinationPath,
				expectedIdentity: writtenStat
			});
		} catch (err) {
			emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
			throw err;
		}
	} finally {
		if (tempPath) await fs$1.rm(tempPath, { force: true }).catch(() => {});
		unregisterTempPath?.();
	}
}
async function writeMissingFileFallback(root, params) {
	const { rootReal, resolved } = await resolvePathInRoot(root, params.relativePath);
	try {
		await assertNoPathAliasEscape({
			absolutePath: resolved,
			rootPath: rootReal,
			boundaryLabel: "root"
		});
	} catch (err) {
		throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
	}
	if (params.mkdir !== false) await fs$1.mkdir(path.dirname(resolved), { recursive: true });
	const parentGuard = await createAsyncDirectoryGuard(path.dirname(resolved));
	let created = false;
	try {
		const { handle, writtenStat } = await withAsyncDirectoryGuards([parentGuard], async () => {
			const handle = await fs$1.open(resolved, OPEN_WRITE_CREATE_FLAGS, params.mode ?? 384);
			created = true;
			try {
				if (typeof params.data === "string") await handle.writeFile(params.data, params.encoding ?? "utf8");
				else await handle.writeFile(params.data);
				return {
					handle,
					writtenStat: await handle.stat()
				};
			} catch (error) {
				await handle.close().catch(() => void 0);
				throw error;
			}
		}, { onPostGuardFailure: async ({ handle }) => {
			created = false;
			await handle.close().catch(() => void 0);
		} });
		await handle.close();
		await verifyAtomicWriteResult({
			root,
			targetPath: resolved,
			expectedIdentity: writtenStat
		});
		created = false;
	} catch (err) {
		if (hasNodeErrorCode(err, "EEXIST")) throw new FsSafeError("already-exists", "file already exists", { cause: err instanceof Error ? err : void 0 });
		throw err;
	} finally {
		if (created) await fs$1.rm(resolved, { force: true }).catch(() => void 0);
	}
}
async function copyFileFallback(root, params, source) {
	let target = null;
	let sourceClosedByStream = false;
	let targetClosedByUs = false;
	let tempHandle = null;
	let tempPath = null;
	let unregisterTempPath = null;
	let tempClosedByStream = false;
	try {
		target = await openWritableFileInRoot(root, {
			relativePath: params.relativePath,
			mkdir: params.mkdir,
			mode: params.mode,
			truncateExisting: false
		});
		const destinationPath = target.realPath;
		const mode = params.mode ?? target.stat.mode & 511;
		await target.handle.close().catch(() => {});
		targetClosedByUs = true;
		const destinationGuard = await createAsyncDirectoryGuard(path.dirname(destinationPath));
		tempPath = buildAtomicWriteTempPath(destinationPath);
		unregisterTempPath = registerTempPathForExit(tempPath);
		tempHandle = await fs$1.open(tempPath, OPEN_WRITE_CREATE_FLAGS, mode || 384);
		const sourceStream = createBoundedReadStream(source, params.maxBytes);
		const targetStream = tempHandle.createWriteStream();
		sourceStream.once("close", () => {
			sourceClosedByStream = true;
		});
		targetStream.once("close", () => {
			tempClosedByStream = true;
		});
		await pipeline(sourceStream, targetStream);
		const writtenStat = await fs$1.stat(tempPath);
		if (!tempClosedByStream) {
			await tempHandle.close().catch(() => {});
			tempClosedByStream = true;
		}
		tempHandle = null;
		const commitTempPath = tempPath;
		await withAsyncDirectoryGuards([destinationGuard], async () => {
			await fs$1.rename(commitTempPath, destinationPath);
		});
		tempPath = null;
		unregisterTempPath();
		unregisterTempPath = null;
		try {
			await verifyAtomicWriteResult({
				root,
				targetPath: destinationPath,
				expectedIdentity: writtenStat
			});
		} catch (err) {
			emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
			throw err;
		}
	} catch (err) {
		if (target?.createdForWrite) await fs$1.rm(target.realPath, { force: true }).catch(() => {});
		throw err;
	} finally {
		if (!sourceClosedByStream) await source.handle.close().catch(() => {});
		if (tempHandle && !tempClosedByStream) await tempHandle.close().catch(() => {});
		if (tempPath) await fs$1.rm(tempPath, { force: true }).catch(() => {});
		unregisterTempPath?.();
		if (target && !targetClosedByUs) await target.handle.close().catch(() => {});
	}
}
//#endregion
//#region node_modules/@openclaw/fs-safe/dist/secure-temp-dir.js
function isNodeErrorWithCode(err, code) {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
function resolveSecureTempRoot(options) {
	const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;
	const accessSync = options.accessSync ?? fs.accessSync;
	const chmodSync = options.chmodSync ?? fs.chmodSync;
	const lstatSync = options.lstatSync ?? fs.lstatSync;
	const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
	const warn = options.warn ?? ((message) => console.warn(message));
	const warningPrefix = options.warningPrefix ?? "[fs-safe]";
	const unsafeFallbackLabel = options.unsafeFallbackLabel ?? "secure temp dir";
	const getuid = options.getuid ?? (() => {
		try {
			return typeof process.getuid === "function" ? process.getuid() : void 0;
		} catch {
			return;
		}
	});
	const tmpdir$1 = typeof options.tmpdir === "function" ? options.tmpdir : tmpdir;
	const platform = options.platform ?? process.platform;
	const uid = getuid();
	const isSecureDirForUser = (st) => {
		if (uid === void 0) return true;
		if (typeof st.uid === "number" && st.uid !== uid) return false;
		if (typeof st.mode === "number" && (st.mode & 18) !== 0) return false;
		return true;
	};
	const fallback = () => {
		const base = tmpdir$1();
		const suffix = uid === void 0 ? options.fallbackPrefix : `${options.fallbackPrefix}-${uid}`;
		return (platform === "win32" ? path.win32.join : path.join)(base, suffix);
	};
	const isTrustedTmpDir = (st) => {
		return st.isDirectory() && !st.isSymbolicLink() && isSecureDirForUser(st);
	};
	const resolveDirState = (candidatePath) => {
		try {
			if (!isTrustedTmpDir(lstatSync(candidatePath))) return "invalid";
			accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
			return "available";
		} catch (err) {
			if (isNodeErrorWithCode(err, "ENOENT")) return "missing";
			return "invalid";
		}
	};
	const tryRepairWritableBits = (candidatePath) => {
		try {
			const st = lstatSync(candidatePath);
			if (!st.isDirectory() || st.isSymbolicLink()) return false;
			if (uid !== void 0 && typeof st.uid === "number" && st.uid !== uid) return false;
			if (typeof st.mode !== "number") return false;
			if ((st.mode & 18) === 0) return resolveDirState(candidatePath) === "available";
			try {
				chmodSync(candidatePath, 448);
			} catch (chmodErr) {
				if (isNodeErrorWithCode(chmodErr, "EPERM") || isNodeErrorWithCode(chmodErr, "EACCES") || isNodeErrorWithCode(chmodErr, "ENOENT")) return resolveDirState(candidatePath) === "available";
				throw chmodErr;
			}
			warn(`${warningPrefix} tightened permissions on temp dir: ${candidatePath}`);
			return resolveDirState(candidatePath) === "available";
		} catch {
			return false;
		}
	};
	const ensureTrustedFallbackDir = () => {
		const fallbackPath = fallback();
		const state = resolveDirState(fallbackPath);
		if (state === "available") return fallbackPath;
		if (state === "invalid") {
			if (tryRepairWritableBits(fallbackPath)) return fallbackPath;
			throw new Error(`Unsafe fallback ${unsafeFallbackLabel}: ${fallbackPath}`);
		}
		try {
			mkdirSync(fallbackPath, {
				recursive: true,
				mode: 448
			});
			chmodSync(fallbackPath, 448);
		} catch {
			throw new Error(`Unable to create fallback ${unsafeFallbackLabel}: ${fallbackPath}`);
		}
		if (resolveDirState(fallbackPath) !== "available" && !tryRepairWritableBits(fallbackPath)) throw new Error(`Unsafe fallback ${unsafeFallbackLabel}: ${fallbackPath}`);
		return fallbackPath;
	};
	if (options.skipPreferredOnWindows === true && platform === "win32") return ensureTrustedFallbackDir();
	if (!options.preferredDir) return ensureTrustedFallbackDir();
	const existingPreferredState = resolveDirState(options.preferredDir);
	if (existingPreferredState === "available") return options.preferredDir;
	if (existingPreferredState === "invalid") {
		if (tryRepairWritableBits(options.preferredDir)) return options.preferredDir;
		return ensureTrustedFallbackDir();
	}
	try {
		accessSync(path.dirname(options.preferredDir), TMP_DIR_ACCESS_MODE);
		mkdirSync(options.preferredDir, {
			recursive: true,
			mode: 448
		});
		chmodSync(options.preferredDir, 448);
		if (resolveDirState(options.preferredDir) !== "available" && !tryRepairWritableBits(options.preferredDir)) return ensureTrustedFallbackDir();
		return options.preferredDir;
	} catch {
		return ensureTrustedFallbackDir();
	}
}
//#endregion
export { resolveOpenedFileRealPathForHandle as a, PATH_ALIAS_POLICIES as c, expandHomePrefix as d, resolveHomeRelativePath as f, readLocalFileSafely as i, assertNoPathAliasEscape as l, DEFAULT_ROOT_MAX_BYTES as n, root as o, resolveUserPath as p, openLocalFileSafely as r, getFsSafeTestHooks as s, resolveSecureTempRoot as t, runPinnedWriteHelper as u };
