#!/usr/bin/python3
"""Archive runtime resources while keeping native signing targets visible."""
import hashlib
import importlib.util
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys


def archive_runtime(app):
    runtime = app / "Contents/Resources/runtime"
    archive = app / "Contents/Resources/runtime.aar"
    plist = app / "Contents/Info.plist"
    with plist.open("rb") as source:
        metadata = plistlib.load(source)
    build_id = metadata.get("OpenClawRuntimeBuildID")
    if (not isinstance(build_id, str) or not build_id
            or build_id in (".", "..", "current", "previous", "helper-current", "helper-previous")
            or "/" in build_id or "\0" in build_id or ".partial-" in build_id):
        raise ValueError("Missing or invalid runtime build ID")
    spec = importlib.util.spec_from_file_location(
        "native_inventory", Path(__file__).parent / "lib/mac-native-inventory.py")
    inventory = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inventory)
    records = inventory.inventory(str(runtime)).split(b"\0")
    retained = {os.fsdecode(records[index + 1]) for index in range(0, len(records) - 1, 2)
                if records[index] in (b"executable", b"library")}
    archived = []
    for directory, directories, files in os.walk(runtime, followlinks=False):
        for name in directories + files:
            entry = Path(directory) / name
            if str(entry) in retained:
                continue
            mode = entry.lstat().st_mode
            if stat.S_ISLNK(mode) or stat.S_ISREG(mode):
                archived.append(entry)
            elif not stat.S_ISDIR(mode):
                raise ValueError(f"Unsupported runtime entry: {entry.relative_to(runtime)}")
    command = ["/usr/bin/aa", "archive", "-d", str(runtime), "-a", "raw", "-t", "8",
               "-exclude-field", "uid,gid"]
    for entry in sorted(retained):
        relative = Path(entry).relative_to(runtime).as_posix()
        command.extend(["-exclude-regex", "^" + re.escape(relative) + "$"])
    digest = hashlib.sha256()
    archive_size = 0
    with archive.open("xb") as output, subprocess.Popen(command, stdout=subprocess.PIPE) as process:
        try:
            for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
                output.write(chunk)
                digest.update(chunk)
                archive_size += len(chunk)
            if process.wait() != 0:
                raise subprocess.CalledProcessError(process.returncode, command)
        except BaseException:
            process.kill()
            raise
    metadata["OpenClawRuntimeArchiveSHA256"] = digest.hexdigest()
    metadata["OpenClawRuntimeArchiveFormatVersion"] = 1
    with plist.open("wb") as output:
        plistlib.dump(metadata, output)
    for entry in archived:
        entry.unlink()
    for directory, _, _ in os.walk(runtime, topdown=False):
        if directory != str(runtime) and not os.listdir(directory):
            os.rmdir(directory)
    print(f"Archived {len(archived)} resources ({archive_size} bytes); retained {len(retained)} native files")


if __name__ == "__main__":
    archive_runtime(Path(sys.argv[1]).resolve(strict=True))
