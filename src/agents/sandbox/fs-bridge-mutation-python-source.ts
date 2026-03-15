// language=python
export const SANDBOX_PINNED_FS_MUTATION_PYTHON = String.raw`import os
import secrets
import subprocess
import sys

operation = sys.argv[1]

DIR_FLAGS = os.O_RDONLY
if hasattr(os, "O_DIRECTORY"):
    DIR_FLAGS |= os.O_DIRECTORY
if hasattr(os, "O_NOFOLLOW"):
    DIR_FLAGS |= os.O_NOFOLLOW

WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    WRITE_FLAGS |= os.O_NOFOLLOW


def open_dir(path, dir_fd=None):
    return os.open(path, DIR_FLAGS, dir_fd=dir_fd)


def walk_parent(root_fd, rel_parent, mkdir_enabled):
    current_fd = os.dup(root_fd)
    try:
        segments = [segment for segment in rel_parent.split("/") if segment and segment != "."]
        for segment in segments:
            if segment == "..":
                raise OSError("path traversal is not allowed")
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


def create_temp_file(parent_fd, basename):
    prefix = ".openclaw-write-" + basename + "."
    for _ in range(128):
        candidate = prefix + secrets.token_hex(6)
        try:
            fd = os.open(candidate, WRITE_FLAGS, 0o600, dir_fd=parent_fd)
            return candidate, fd
        except FileExistsError:
            continue
    raise RuntimeError("failed to allocate sandbox temp file")


def fd_path(fd, basename=None):
    base = f"/proc/self/fd/{fd}"
    if basename is None:
        return base
    return f"{base}/{basename}"


def run_command(argv, pass_fds):
    subprocess.run(argv, check=True, pass_fds=tuple(pass_fds))


def write_stdin_to_fd(fd):
    while True:
        chunk = sys.stdin.buffer.read(65536)
        if not chunk:
            break
        os.write(fd, chunk)


def run_write(args):
    mount_root, relative_parent, basename, mkdir_enabled_raw = args
    mkdir_enabled = mkdir_enabled_raw == "1"
    root_fd = open_dir(mount_root)
    parent_fd = None
    temp_fd = None
    temp_name = None
    try:
        parent_fd = walk_parent(root_fd, relative_parent, mkdir_enabled)
        temp_name, temp_fd = create_temp_file(parent_fd, basename)
        write_stdin_to_fd(temp_fd)
        os.fsync(temp_fd)
        os.close(temp_fd)
        temp_fd = None
        os.replace(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
    except Exception:
        if temp_fd is not None:
            os.close(temp_fd)
            temp_fd = None
        if temp_name is not None and parent_fd is not None:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        raise
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
        os.close(root_fd)


def run_mkdirp(args):
    mount_root, relative_parent, basename = args
    root_fd = open_dir(mount_root)
    parent_fd = None
    try:
        parent_fd = walk_parent(root_fd, relative_parent, True)
        run_command(["mkdir", "-p", "--", fd_path(parent_fd, basename)], [parent_fd])
        os.fsync(parent_fd)
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
        os.close(root_fd)


def run_remove(args):
    mount_root, relative_parent, basename, recursive_raw, force_raw = args
    root_fd = open_dir(mount_root)
    parent_fd = None
    try:
        parent_fd = walk_parent(root_fd, relative_parent, False)
        argv = ["rm"]
        if force_raw == "1":
            argv.append("-f")
        if recursive_raw == "1":
            argv.append("-r")
        argv.extend(["--", fd_path(parent_fd, basename)])
        run_command(argv, [parent_fd])
        os.fsync(parent_fd)
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
        os.close(root_fd)


def run_rename(args):
    (
        from_mount_root,
        from_relative_parent,
        from_basename,
        to_mount_root,
        to_relative_parent,
        to_basename,
    ) = args
    from_root_fd = open_dir(from_mount_root)
    to_root_fd = open_dir(to_mount_root)
    from_parent_fd = None
    to_parent_fd = None
    try:
        from_parent_fd = walk_parent(from_root_fd, from_relative_parent, False)
        to_parent_fd = walk_parent(to_root_fd, to_relative_parent, True)
        run_command(
            [
                "mv",
                "--",
                fd_path(from_parent_fd, from_basename),
                fd_path(to_parent_fd, to_basename),
            ],
            [from_parent_fd, to_parent_fd],
        )
        os.fsync(from_parent_fd)
        if to_parent_fd != from_parent_fd:
            os.fsync(to_parent_fd)
    finally:
        if from_parent_fd is not None:
            os.close(from_parent_fd)
        if to_parent_fd is not None:
            os.close(to_parent_fd)
        os.close(from_root_fd)
        os.close(to_root_fd)


OPERATIONS = {
    "write": run_write,
    "mkdirp": run_mkdirp,
    "remove": run_remove,
    "rename": run_rename,
}

if operation not in OPERATIONS:
    raise RuntimeError(f"unknown sandbox fs mutation: {operation}")

OPERATIONS[operation](sys.argv[2:])`;
