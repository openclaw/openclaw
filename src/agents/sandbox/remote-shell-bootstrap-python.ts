import { SANDBOX_RENAME_NO_REPLACE_PYTHON } from "./fs-bridge-native-mutation-python.js";

const REMOVE_OWNED_STAGE = [
  "def remove_owned_stage(staging):",
  "    try:",
  "        root = os.lstat(staging)",
  "    except FileNotFoundError:",
  "        return",
  "    if not stat.S_ISDIR(root.st_mode):",
  "        raise OSError(errno.ENOTDIR, 'bootstrap staging path is not a directory', staging)",
  "    def restore_directories(directory):",
  "        mode = os.lstat(directory).st_mode",
  "        if not stat.S_ISDIR(mode):",
  "            return",
  "        # Tar can restore readonly or unsearchable modes after extracting children.",
  "        # Change only owned directories, before traversing them; never follow links.",
  "        os.chmod(directory, stat.S_IMODE(mode) | 0o700, follow_symlinks=False)",
  "        with os.scandir(directory) as entries:",
  "            for entry in entries:",
  "                if entry.is_dir(follow_symlinks=False):",
  "                    restore_directories(entry.path)",
  "    restore_directories(staging)",
  "    shutil.rmtree(staging)",
].join("\n");

export const PUBLISH_REMOTE_WORKSPACE = [
  "import ctypes, errno, os, shutil, stat, sys",
  SANDBOX_RENAME_NO_REPLACE_PYTHON,
  REMOVE_OWNED_STAGE,
  "staging, destination = sys.argv[1:]",
  "parent = os.path.dirname(destination)",
  "if os.path.dirname(staging) != parent:",
  "    raise ValueError('bootstrap staging must share the destination parent')",
  "parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)",
  "try:",
  "    try:",
  "        rename_no_replace(parent_fd, os.path.basename(staging), parent_fd, os.path.basename(destination))",
  "    except OSError as error:",
  "        if error.errno not in (errno.EEXIST, errno.ENOTEMPTY):",
  "            raise OSError(error.errno, 'atomic no-replace directory publication failed; a supported remote rename primitive and writable parent directory are required: ' + str(error), destination) from error",
  "        winner = os.lstat(os.path.basename(destination), dir_fd=parent_fd)",
  "        if not stat.S_ISDIR(winner.st_mode):",
  "            raise",
  "        remove_owned_stage(staging)",
  "finally:",
  "    os.close(parent_fd)",
].join("\n");

export const CLEANUP_REMOTE_WORKSPACE_STAGE = [
  "import errno, os, shutil, stat, sys",
  REMOVE_OWNED_STAGE,
  "remove_owned_stage(sys.argv[1])",
].join("\n");
