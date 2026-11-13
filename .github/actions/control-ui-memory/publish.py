"""Run through the prepared CI Git owner; never force-push or retire snapshots."""
import json
import os
from pathlib import Path
import subprocess

from ci_git_owner import git_auth_environment, git_output, run_git

root = Path(os.environ["GITHUB_WORKSPACE"])
store = root / ".openclaw/tmp/control-ui-memory-store"
repository = os.environ["MEMORY_REPOSITORY"]
pin = json.loads((root / "ui/src/i18n/.i18n/memory-revision.json").read_text())
if pin["repository"] != repository:
    raise RuntimeError("Canonical memory destination changed")
files = [locale + ".tm.jsonl" for locale in pin["files"]]
run_git(str(store), "add", "--", *files)
if git_output(str(store), "diff", "--cached", "--name-only").strip():
    run_git(str(store), "-c", "user.name=github-actions[bot]",
            "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
            "commit", "-m", "chore(i18n): retain canonical Control UI memory")
revision = git_output(str(store), "rev-parse", "HEAD").strip()
remote = "https://github.com/" + repository + ".git"
# Fast-forward only. A failed/uncertain push stops before writing any main pin.
run_git(str(store), "push", remote, "HEAD:refs/heads/main", timeout=120,
        env=git_auth_environment(remote, os.environ["MEMORY_TOKEN"]))
subprocess.run(["node", "--import", "tsx", "scripts/control-ui-i18n-memory.ts",
                "pin", str(store), repository, revision], cwd=root, check=True)
