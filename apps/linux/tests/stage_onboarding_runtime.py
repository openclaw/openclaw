"""Stage the synthetic CLI before compiling the native onboarding fixture."""
import hashlib
import json
from pathlib import Path
import shutil
import sys


def stage_onboarding_runtime(runtime):
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if manifest["runtime"]["flavor"] != "jit":
        raise ValueError("The synthetic onboarding CLI requires the JIT runtime")
    # Cargo copies resources without removing files from a previous package.
    copied = runtime.parent / "debug/desktop-runtime"
    if copied.exists():
        shutil.rmtree(copied)
    manifest["files"] = {name: digest for name, digest in manifest["files"].items()
                         if not name.startswith("package/")}
    package = runtime / "package"
    if package.exists():
        shutil.rmtree(package)
    entry = "package/node_modules/openclaw/openclaw.mjs"
    content = (Path(__file__).parent / "fixtures/onboarding-cli.mjs").read_bytes()
    destination = runtime / entry
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"OPENCLAW-BUN-RUNTIME-V1\n" + content)
    manifest["files"][entry] = hashlib.sha256(content).hexdigest()
    manifest["runtime"]["entry"] = entry
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    stage_onboarding_runtime(Path(sys.argv[1]))
