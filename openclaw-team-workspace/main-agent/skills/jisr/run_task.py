import os
import asyncio
import subprocess
import sys
from pathlib import Path


def run():
    user_id = os.getenv("USER_ID", "123")

    env = os.environ.copy()
    env["CUA_SERVICE_WEBSOCKET"] = f"ws://localhost:7002/cua/{user_id}/api/ws/run-agent"
    env["BROWSER_SERVICE_URL"] = "http://localhost:7002"
    env["CUA_ORCHESTRATOR_URL"] = "http://localhost:9000"
    env["CUA_HEALTH_URL"] = f"http://localhost:7002/cua/{user_id}/api/health"

    # Resolve cua_client.py relative to this file's location.
    # Works on any machine and inside the container.
    script_path = Path(__file__).parent / "cua_client.py"

    cmd = [
        sys.executable,
        str(script_path),
        "--task", "Summarize all pending Jisr approvals"
    ]

    result = subprocess.run(cmd, env=env, capture_output=True, text=True)
    print(result.stdout)
    print(result.stderr, file=sys.stderr)


if __name__ == "__main__":
    run()