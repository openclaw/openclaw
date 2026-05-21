import subprocess
import sys
from pathlib import Path


def run():
    # Resolve cua_client.py relative to this file's location.
    # Works on any machine and inside the container.
    script_path = Path(__file__).parent / "cua_client.py"

    cmd = [
        sys.executable,
        str(script_path),
        "--task", "Summarize all pending Jisr approvals"
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    print(result.stdout)
    print(result.stderr, file=sys.stderr)


if __name__ == "__main__":
    run()
