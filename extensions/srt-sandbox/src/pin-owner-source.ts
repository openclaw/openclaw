// Persistent per-scope pin-owner program (Stage S3, design v8 §2–§3).
//
// The AC4 exact-location guarantee (方案 2) requires that the directory handles
// walked during resolvePinnedMutationTarget stay open in ONE process until the
// paired mutation runs, so the mutation lands on the file description (vnode)
// that was authorized — not on whatever the path resolves to at mutation time.
// A Unix fd binds the open vnode, not the path name or the inode NUMBER, so a
// post-resolve component swap cannot redirect the write and a deleted target
// fails closed with ENOENT (verified darwin 24.3.0 / py 3.9.6, v8 §2).
//
// This program is that owner. It is launched once per scope INSIDE the SRT
// sandbox (wrapWithSandboxArgv), so every open/mutation it performs is
// kernel-enforced against the scope's allowWrite/read policy — the held-handle
// model composes with, never bypasses, Seatbelt/bwrap enforcement. It speaks a
// minimal length-delimited (newline) JSON RPC over stdin/stdout:
//
//   resolve  -> walk root + rel segments with O_NOFOLLOW|O_DIRECTORY, KEEP the
//               fds open under an owner-assigned opId, return the held depth.
//   mutate   -> perform write/create/mkdir/remove relative to the held parent
//               fd (leaf opened O_NOFOLLOW; create uses O_EXCL), then release.
//   release  -> drop a held pin (resolve with no following mutate; also the
//               bridge's idle-timeout path) so fds never leak.
//   read/stat/rename -> one-shot helpers (reads follow the open read policy;
//               rename walks both parents O_NOFOLLOW and renameat()s).
//   ping/shutdown -> health (reports held-pin and open-fd counts) / clean exit.
//
// Embedded as a shell literal and run via `python3 -c`, mirroring the core
// mutation helper's GUEST_FILESYSTEM_PYTHON idiom (no separate file to ship).
export const PIN_OWNER_PYTHON = String.raw`
import sys, os, json, base64, errno
import stat as statmod

O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
# Defence-in-depth: the bridge caps depth too, but never let a single pin walk
# unbounded even if the bridge is bypassed.
MAX_DEPTH = 256
DIR_WALK_FLAGS = os.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC

held = {}

def raise_nofile_headroom():
    try:
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        want = 4096
        if hard != resource.RLIM_INFINITY and hard < want:
            want = hard
        if soft < want:
            resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
    except Exception:
        pass

def respond(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def err_payload(e):
    code = ""
    if isinstance(e, OSError) and e.errno is not None:
        code = errno.errorcode.get(e.errno, "")
    return {"ok": False, "error": str(e), "errno": code}

def valid_component(seg):
    return seg not in ("", ".", "..") and "/" not in seg and "\x00" not in seg

def close_fd(fd):
    try:
        os.close(fd)
    except OSError:
        pass

def open_root(root):
    if not isinstance(root, str) or not root.startswith("/"):
        raise ValueError("pin root must be an absolute path")
    return os.open(root, os.O_RDONLY | O_DIRECTORY | O_CLOEXEC)

def walk_hold(root, rel):
    # Anchor on the (trusted, already-canonical) mount root, then walk the
    # sandbox-writable segments WITHOUT following symlinks. A symlink component
    # fails the open (ELOOP/ENOTDIR) -> fail closed, never redirect.
    fds = [open_root(root)]
    try:
        segs = [s for s in (rel or "").split("/") if s != ""]
        if len(segs) > MAX_DEPTH:
            raise ValueError("pin depth exceeds maximum")
        for seg in segs:
            if not valid_component(seg):
                raise ValueError("invalid path component")
            fds.append(os.open(seg, DIR_WALK_FLAGS, dir_fd=fds[-1]))
    except Exception:
        for fd in fds:
            close_fd(fd)
        raise
    return fds

def release(op_id):
    entry = held.pop(op_id, None)
    if entry is not None:
        for fd in entry["fds"]:
            close_fd(fd)

def op_resolve(req):
    op_id = req["opId"]
    if op_id in held:
        raise ValueError("opId already held")
    fds = walk_hold(req["root"], req.get("rel", ""))
    held[op_id] = {
        "fds": fds,
        "leaf": req.get("leaf", ""),
        "mode": req.get("mode", "file"),
    }
    return {"ok": True, "opId": op_id, "depth": len(fds)}

def do_write(parent_fd, leaf, data, excl):
    if not valid_component(leaf):
        raise ValueError("invalid leaf component")
    flags = os.O_WRONLY | os.O_CREAT | O_NOFOLLOW | O_CLOEXEC
    flags |= os.O_EXCL if excl else os.O_TRUNC
    try:
        fd = os.open(leaf, flags, 0o600, dir_fd=parent_fd)
    except FileExistsError:
        if excl:
            return {"ok": True, "result": "exists"}
        raise
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return {"ok": True, "result": "created"}

def do_mkdir(parent_fd, suffix):
    cur = parent_fd
    opened = []
    try:
        for seg in [s for s in suffix.split("/") if s != ""]:
            if not valid_component(seg):
                raise ValueError("invalid path component")
            try:
                os.mkdir(seg, 0o700, dir_fd=cur)
            except FileExistsError:
                pass
            nfd = os.open(seg, DIR_WALK_FLAGS, dir_fd=cur)
            opened.append(nfd)
            cur = nfd
    finally:
        for fd in opened:
            close_fd(fd)
    return {"ok": True, "result": "created"}

def rmtree_at(parent_fd, name):
    dir_fd = os.open(name, DIR_WALK_FLAGS, dir_fd=parent_fd)
    try:
        for entry in os.listdir(dir_fd):
            est = os.stat(entry, dir_fd=dir_fd, follow_symlinks=False)
            if statmod.S_ISDIR(est.st_mode):
                rmtree_at(dir_fd, entry)
            else:
                os.unlink(entry, dir_fd=dir_fd)
    finally:
        close_fd(dir_fd)
    os.rmdir(name, dir_fd=parent_fd)

def do_remove(parent_fd, leaf, recursive, force):
    if not valid_component(leaf):
        raise ValueError("invalid leaf component")
    try:
        st = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        if force:
            return {"ok": True, "result": "absent"}
        raise
    if statmod.S_ISDIR(st.st_mode):
        if recursive:
            rmtree_at(parent_fd, leaf)
        else:
            os.rmdir(leaf, dir_fd=parent_fd)
    else:
        os.unlink(leaf, dir_fd=parent_fd)
    return {"ok": True, "result": "removed"}

def op_mutate(req):
    op_id = req["opId"]
    entry = held.get(op_id)
    if entry is None:
        # No held pin -> the fds were released/timed out/never resolved. Fail
        # closed rather than silently re-resolving (that would drop AC4).
        raise ValueError("no held pin for opId")
    try:
        parent_fd = entry["fds"][-1]
        leaf = entry["leaf"]
        kind = req["kind"]
        if kind == "write":
            return do_write(parent_fd, leaf, base64.b64decode(req.get("data", "")), False)
        if kind == "create":
            return do_write(parent_fd, leaf, base64.b64decode(req.get("data", "")), True)
        if kind == "mkdir":
            return do_mkdir(parent_fd, leaf)
        if kind == "remove":
            return do_remove(parent_fd, leaf, bool(req.get("recursive", False)), bool(req.get("force", True)))
        raise ValueError("unknown mutate kind: " + str(kind))
    finally:
        release(op_id)

def op_release(req):
    release(req["opId"])
    return {"ok": True}

def op_read(req):
    path = req["path"]
    max_bytes = req.get("maxBytes")
    fd = os.open(path, os.O_RDONLY | O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not statmod.S_ISREG(st.st_mode):
            raise ValueError("sandbox read requires a regular file")
        if max_bytes is not None and st.st_size > max_bytes:
            raise ValueError("file exceeds maximum read size")
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 262144)
            if not chunk:
                break
            total += len(chunk)
            if max_bytes is not None and total > max_bytes:
                raise ValueError("file exceeds maximum read size")
            chunks.append(chunk)
    finally:
        close_fd(fd)
    return {"ok": True, "data": base64.b64encode(b"".join(chunks)).decode("ascii")}

def op_stat(req):
    path = req["path"]
    try:
        st = os.stat(path, follow_symlinks=True)
    except (FileNotFoundError, NotADirectoryError):
        return {"ok": True, "stat": None}
    if statmod.S_ISDIR(st.st_mode):
        kind = "directory"
    elif statmod.S_ISREG(st.st_mode):
        kind = "file"
    else:
        kind = "other"
    return {"ok": True, "stat": {"type": kind, "size": st.st_size, "mtimeMs": st.st_mtime * 1000.0}}

def op_rename(req):
    src = walk_hold(req["fromRoot"], req.get("fromRel", ""))
    dst = None
    try:
        dst = walk_hold(req["toRoot"], req.get("toRel", ""))
        from_leaf = req["fromLeaf"]
        to_leaf = req["toLeaf"]
        if not valid_component(from_leaf) or not valid_component(to_leaf):
            raise ValueError("invalid rename component")
        os.rename(from_leaf, to_leaf, src_dir_fd=src[-1], dst_dir_fd=dst[-1])
        return {"ok": True, "result": "renamed"}
    finally:
        for fd in src:
            close_fd(fd)
        if dst is not None:
            for fd in dst:
                close_fd(fd)

def open_fd_count():
    try:
        return len(os.listdir("/dev/fd"))
    except OSError:
        return -1

def op_ping(req):
    return {"ok": True, "pong": True, "pid": os.getpid(), "held": len(held), "fds": open_fd_count()}

DISPATCH = {
    "resolve": op_resolve,
    "mutate": op_mutate,
    "release": op_release,
    "read": op_read,
    "stat": op_stat,
    "rename": op_rename,
    "ping": op_ping,
}

def main():
    raise_nofile_headroom()
    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            respond({"id": None, "ok": False, "error": "bad request: " + str(exc)})
            continue
        rid = req.get("id")
        op = req.get("op")
        if op == "shutdown":
            respond({"id": rid, "ok": True, "result": "bye"})
            break
        fn = DISPATCH.get(op)
        if fn is None:
            respond({"id": rid, "ok": False, "error": "unknown op: " + str(op)})
            continue
        try:
            out = fn(req)
        except Exception as exc:
            out = err_payload(exc)
        out["id"] = rid
        respond(out)

main()
`;

/**
 * POSIX python interpreter candidates, in priority order. Mirrors the core
 * mutation helper's candidate list so the pin owner starts on the same
 * interpreters the approved fs-bridge path already depends on.
 */
export const PIN_OWNER_PYTHON_CANDIDATES = [
  "/usr/bin/python3",
  "/usr/local/bin/python3",
  "/opt/homebrew/bin/python3",
  "/bin/python3",
] as const;

/**
 * Build the shell command that launches the persistent pin owner. Selects the
 * first available python3 (fail-closed with exit 127 if none), then execs it on
 * the embedded program with stdin/stdout as the RPC channel. Wrap the result
 * with wrapWithSandboxArgv so the owner runs under kernel enforcement.
 */
export function buildPinOwnerCommand(): string {
  const literal = `'${PIN_OWNER_PYTHON.replaceAll("'", `'\\''`)}'`;
  return [
    "set -eu",
    "python_cmd=''",
    ...PIN_OWNER_PYTHON_CANDIDATES.map(
      (candidate) =>
        `if [ -z "$python_cmd" ] && [ -x '${candidate}' ]; then python_cmd='${candidate}'; fi`,
    ),
    'if [ -z "$python_cmd" ]; then python_cmd=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true); fi',
    'if [ -z "$python_cmd" ]; then',
    "  echo >&2 'srt-sandbox pin owner requires python3 or python'",
    "  exit 127",
    "fi",
    `pin_owner_script=${literal}`,
    'exec "$python_cmd" -c "$pin_owner_script"',
  ].join("\n");
}
