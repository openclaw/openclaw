from __future__ import annotations

import importlib.metadata


__all__ = ["tag", "version", "commit"]


# ========= =========== ===================
#           release     development
# ========= =========== ===================
# tag       X.Y         X.Y (upcoming)
# version   X.Y         X.Y.dev1+g5678cde
# commit    X.Y         5678cde
# ========= =========== ===================


# When tagging a release, set `released = True`.
# After tagging a release, set `released = False` and increment `tag`.

released = False

tag = version = commit = "16.1"


if not released:  # pragma: no cover
    import pathlib
    import re
    import subprocess

    def get_version(tag: str) -> str:
        # Since setup.py executes the contents of src/websockets/version.py,
        # __file__ can point to either of these two files.
        file_path = pathlib.Path(__file__)
        root_dir = file_path.parents[0 if file_path.name == "setup.py" else 2]

        # Read version from package metadata if it is installed.
        try:
            version = importlib.metadata.version("websockets")
        except ImportError:
            pass
        else:
            # Check that this file belongs to the installed package.
            files = importlib.metadata.files("websockets")
            if files:
                version_files = [f for f in files if f.name == file_path.name]
                if version_files:
                    version_file = version_files[0]
                    if version_file.locate() == file_path:
                        return version

        # Read version from git if available.
        try:
            description = subprocess.run(
                ["git", "describe", "--dirty", "--tags", "--long"],
                capture_output=True,
                cwd=root_dir,
                timeout=1,
                check=True,
                text=True,
            ).stdout.strip()
        # subprocess.run raises FileNotFoundError if git isn't on $PATH.
        except (
            FileNotFoundError,
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
        ):
            pass
        else:
            description_re = r"[0-9.]+-([0-9]+)-(g[0-9a-f]{7,}(?:-dirty)?)"
            match = re.fullmatch(description_re, description)
            if match is None:
                raise ValueError(f"Unexpected git description: {description}")
            distance, remainder = match.groups()
            remainder = remainder.replace("-", ".")  # required by PEP 440
            return f"{tag}.dev{distance}+{remainder}"

        # Avoid crashing if the development version cannot be determined.
        return f"{tag}.dev0+gunknown"

    version = get_version(tag)

    def get_commit(tag: str, version: str) -> str:
        # Extract commit from version, falling back to tag if not available.
        version_re = r"[0-9.]+\.dev[0-9]+\+g([0-9a-f]{7,}|unknown)(?:\.dirty)?"
        match = re.fullmatch(version_re, version)
        if match is None:
            raise ValueError(f"Unexpected version: {version}")
        (commit,) = match.groups()
        return tag if commit == "unknown" else commit

    commit = get_commit(tag, version)
