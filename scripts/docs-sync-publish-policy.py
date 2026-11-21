"""Native Git-owner policy for docs mirror preparation and PR publication."""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from ci_git_owner import run_git, GitFailure, FetchTimeout, backoff, check_cancelled

OWNED = ("docs", ".openclaw-sync", "package.json", "package-lock.json")
REPO = "openclaw/docs"
PREFIX = "automation/docs-mirror/"
CONTEXT = "Publication merge admission"
publish = os.getcwd()
workspace = os.environ["GITHUB_WORKSPACE"]
source_sha = os.environ["GITHUB_SHA"]


def git(*args):
    with tempfile.TemporaryFile() as output:
        run_git(publish, *args, stdout=output, reclaim_locks=True)
        output.seek(0)
        return output.read()


def oid(value):
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise Hold("Invalid immutable Git identity")
    return value


def tree(revision):
    return hashlib.sha1(git("ls-tree", "-r", "-z", revision, "--", *OWNED)).hexdigest()


def candidate(head, base, digest):
    if git("rev-list", "--parents", "-n", "1", head).decode().split() != [head, base]:
        raise Hold("Candidate must have exactly the recorded target base as its sole parent")
    changed = git("diff", "--no-renames", "--name-only", "-z", base, head).decode().split("\0")
    if any(name and not any(name == root or name.startswith(root + "/") for root in OWNED)
           for name in changed):
        raise Hold("Candidate changes paths outside the docs mirror owner")
    metadata = json.loads(git("show", head + ":.openclaw-sync/source.json"))
    if metadata.get("sha") != source_sha or metadata.get("repository") != os.environ["GITHUB_REPOSITORY"]:
        raise Hold("Candidate does not record the exact source revision/repository")
    if tree(head) != digest:
        raise Hold("Candidate owned tree changed after validation")


def prepared():
    head = oid(git("rev-parse", "HEAD").decode().strip())
    base = oid(git("rev-parse", "refs/remotes/origin/main").decode().strip())
    digest = tree(head)
    candidate(head, base, digest)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"head={head}\nbase={base}\ntree={digest}\nready=true\n")
    print(f"Prepared docs mirror {head}; publication is pending.", flush=True)


def prepare():
    installed_inputs = None

    def validate_publish_docs():
        nonlocal installed_inputs
        current_inputs = tuple(Path(publish, name).read_bytes()
                               for name in ("package.json", "package-lock.json"))
        if installed_inputs != current_inputs:
            subprocess.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                           cwd=publish, check=True)
            installed_inputs = current_inputs
        # Validate the actual rebased tree before freezing the PR candidate.
        # Node 24 runs this erasable TypeScript closure without an extra loader.
        subprocess.run(["node", ".openclaw-sync/check-docs-mdx.mts", "docs",
                        "--cache-file", os.environ["OPENCLAW_DOCS_MDX_CACHE"]],
                       cwd=publish, check=True)

    def invalid_json_constant(value):
        raise json.JSONDecodeError("Invalid JSON constant", value, 0)

    def validate_publisher_dependencies():
        baseline = {}
        for key, filename in (("packageJson", "package.json"), ("packageLock", "package-lock.json")):
            with tempfile.TemporaryFile() as output:
                run_git(publish, "show", f"refs/remotes/origin/main:{filename}", stdout=output)
                output.seek(0)
                baseline[key] = json.loads(output.read().decode("utf-8"),
                                           parse_constant=invalid_json_constant)
        subprocess.run([
            "node", "--input-type=module", "-e",
            "import fs from 'node:fs'; "
            "import { validateDocsSyncDependencies } from './scripts/docs-sync-publish.mjs'; "
            "validateDocsSyncDependencies(process.argv[1], JSON.parse(fs.readFileSync(0, 'utf8')));",
            publish,
        ], cwd=workspace, input=json.dumps(baseline), text=True, check=True)

    def remote_source_sha():
        try:
            with tempfile.TemporaryFile() as output:
                run_git(publish, "show", "refs/remotes/origin/main:.openclaw-sync/source.json",
                        stdout=output, stderr=subprocess.DEVNULL)
                output.seek(0)
                data = json.loads(output.read().decode("utf-8", errors="replace"),
                                  parse_constant=invalid_json_constant)
            sha = data.get("sha") if isinstance(data, dict) else None
            return sha.rstrip("\n") if isinstance(sha, str) else ""
        except (GitFailure, json.JSONDecodeError):
            return ""

    def skip_stale_source():
        current_source_sha = remote_source_sha()
        if not current_source_sha or current_source_sha == source_sha:
            return
        try:
            run_git(workspace, "merge-base", "--is-ancestor", source_sha, current_source_sha)
        except GitFailure:
            return
        print(f"Skipping stale publish sync for {source_sha}; origin/main already mirrors {current_source_sha}.")
        raise SystemExit(0)

    try:
        run_git(publish, "diff", "--quiet", "--", "docs", ".openclaw-sync", "package.json", "package-lock.json")
    except GitFailure:
        pass
    else:
        print("No publish-repo changes.")
        raise SystemExit(0)

    try:
        run_git(publish, "fetch", "origin", "main:refs/remotes/origin/main", timeout=120, reclaim_locks=True)
    except (GitFailure, FetchTimeout):
        pass
    else:
        skip_stale_source()

    run_git(publish, "config", "user.name", "openclaw-docs-sync[bot]", reclaim_locks=True)
    run_git(publish, "config", "user.email", "openclaw-docs-sync[bot]@users.noreply.github.com", reclaim_locks=True)
    run_git(publish, "add", "docs", ".openclaw-sync", "package.json", "package-lock.json", reclaim_locks=True)
    run_git(publish, "commit", "-m", f"chore(sync): mirror docs from {os.environ['GITHUB_REPOSITORY']}@{source_sha}", reclaim_locks=True)
    for attempt in range(1, 6):
        try:
            run_git(publish, "fetch", "origin", "main:refs/remotes/origin/main", timeout=120, reclaim_locks=True)
            skip_stale_source()
            run_git(publish, "rebase", "-X", "theirs", "origin/main", reclaim_locks=True)
            validate_publisher_dependencies()
            validate_publish_docs()
            prepared()
            raise SystemExit(0)
        except (GitFailure, FetchTimeout):
            # Only verified Git failure may reach abort/retry; ownership
            # uncertainty and cancellation escape the connected policy.
            try:
                run_git(publish, "rebase", "--abort", stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, reclaim_locks=True)
            except GitFailure:
                pass
            print(f"Publish sync attempt {attempt} failed; retrying.", flush=True)
            backoff(attempt * 2)
    print("Failed to prepare publish-repo sync after retries.")
    raise SystemExit(1)


class Hold(RuntimeError):
    """A visible, retained publication that requires operator attention."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise Hold("GitHub API redirected; refusing credential forwarding")


class GitHub:
    def __init__(self):
        self.deadline = time.monotonic() + 600
        self.opener = urllib.request.build_opener(NoRedirect)
        self.root = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")

    def request(self, path, method="GET", data=None):
        check_cancelled()
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Hold("Publication deadline expired; retained candidate needs attention")
        request = urllib.request.Request(self.root + "/" + path, method=method,
            data=None if data is None else json.dumps(data).encode(), headers={
                "Authorization": "Bearer " + os.environ["OPENCLAW_DOCS_SYNC_TOKEN"],
                "Accept": "application/vnd.github+json", "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28"})
        try:
            with self.opener.open(request, timeout=min(20, remaining)) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024 or 'rel="next"' in response.headers.get("Link", ""):
                    raise Hold("Incomplete GitHub enumeration; refusing publication")
                return json.loads(raw)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            # Do not print the request or exception body: authentication stays private.
            raise Hold("GitHub API request failed: " + method + " " + path.split("?")[0]) from error

    def repo(self, path, **kwargs):
        return self.request("repos/" + REPO + "/" + path, **kwargs)

    def pulls(self, branch):
        query = urllib.parse.urlencode({"state": "all", "base": "main", "per_page": 100,
                                        "head": "openclaw:" + branch})
        rows = self.repo("pulls?" + query)
        if len(rows) >= 100:
            raise Hold("Incomplete candidate PR history")
        return [pr for pr in rows if pr["head"]["ref"] == branch
                and pr["head"]["repo"]["full_name"] == REPO]

    def guard(self, allowed=None):
        rows = self.repo("pulls?state=open&base=main&per_page=100")
        if len(rows) >= 100:
            raise Hold("Incomplete open PR inventory")
        for pr in rows:
            if pr["head"]["ref"].startswith(PREFIX) and pr["head"]["repo"]["full_name"] == REPO:
                if (pr["head"]["ref"], pr["head"]["sha"]) != allowed:
                    raise Hold("Unresolved docs mirror PR: " + pr["html_url"])
        # Matching refs returns all matches, without a pagination parameter.
        retained = False
        for ref in self.repo("git/matching-refs/heads/" + PREFIX):
            branch = ref["ref"].removeprefix("refs/heads/")
            if (branch, ref["object"]["sha"]) == allowed:
                retained = True
                continue
            if not any(pr.get("merged_at") and pr["head"]["sha"] == ref["object"]["sha"]
                       for pr in self.pulls(branch)):
                raise Hold("Unresolved docs mirror branch: https://github.com/" + REPO + "/tree/" + branch)

        return retained

    def admission_rule(self):
        app = self.request("apps/github-actions")["id"]
        rules = self.repo("rules/branches/main?per_page=100")
        if len(rules) >= 100:
            raise Hold("Incomplete effective target rules")
        strict = any(rule["type"] == "required_status_checks"
                     and rule["parameters"].get("strict_required_status_checks_policy") is True
                     and {"context": CONTEXT, "integration_id": app} in rule["parameters"].get("required_status_checks", [])
                     for rule in rules)
        if not strict or not any(rule["type"] == "non_fast_forward" for rule in rules):
            raise Hold("Target strict Actions publication admission rule is not active")
        for rule_id in {rule["ruleset_id"] for rule in rules}:
            rule = self.repo(f"rulesets/{rule_id}?includes_parents=true")
            if rule.get("enforcement") != "active" or rule.get("bypass_actors", []) != [] or rule.get("current_user_can_bypass", "never") != "never":
                raise Hold("Target ruleset permits bypass or is not active")
        # Bypass fields may be redacted. Administrator activation owns that proof;
        # visible bypasses are rejected here, never silently accepted.


def fresh(base):
    run_git(publish, "fetch", "origin", "main:refs/remotes/origin/main", timeout=120, reclaim_locks=True)
    if git("rev-parse", "refs/remotes/origin/main").decode().strip() != base:
        raise Hold("Target main advanced; retain candidate for fresh source validation")
    try:
        metadata = json.loads(git("show", base + ":.openclaw-sync/source.json"))
    except (GitFailure, json.JSONDecodeError):
        return
    mirrored = metadata.get("sha") if isinstance(metadata, dict) else None
    if mirrored and mirrored != source_sha:
        try:
            run_git(workspace, "merge-base", "--is-ancestor", source_sha, mirrored)
        except GitFailure:
            return
        raise Hold("Target already mirrors a newer source; retain candidate")


def receipt(pr, head, base, digest):
    if (not pr.get("merged") or pr["head"]["sha"] != head
            or pr["head"]["repo"]["full_name"] != REPO
            or pr["base"]["ref"] != "main" or pr["base"]["repo"]["full_name"] != REPO):
        raise Hold("PR is not merged into the target at the prepared head")
    merged = oid(pr["merge_commit_sha"])
    run_git(publish, "fetch", "origin", "main:refs/remotes/origin/main", timeout=120, reclaim_locks=True)
    run_git(publish, "merge-base", "--is-ancestor", merged, "refs/remotes/origin/main")
    candidate(merged, base, digest)
    if git("rev-parse", merged + "^{tree}") != git("rev-parse", head + "^{tree}"):
        raise Hold("Merged tree differs from the validated candidate")
    print(f"Published docs through {pr['html_url']} at {merged} (source {source_sha}).", flush=True)


def publication(api):
    head, base, digest = (oid(os.environ[name]) for name in
                          ("DOCS_PUBLISH_HEAD", "DOCS_PUBLISH_BASE", "DOCS_PUBLISH_TREE"))
    if git("rev-parse", "HEAD").decode().strip() != head or git("status", "--porcelain", "--untracked-files=no"):
        raise Hold("Prepared checkout changed before publication")
    candidate(head, base, digest)
    branch = PREFIX + source_sha + "-" + digest + "-" + base
    retained = api.guard((branch, head))
    # Persist before freshness/rule holds so a validated payload is never lost.
    print("Docs candidate recovery URL: https://github.com/" + REPO + "/tree/" + branch, flush=True)
    if not retained:
        try:
            run_git(publish, "push", "--force-with-lease=refs/heads/" + branch + ":",
                    "origin", head + ":refs/heads/" + branch, reclaim_locks=True)
        except (GitFailure, FetchTimeout):
            refs = api.repo("git/matching-refs/heads/" + branch)
            if not any(ref["ref"] == "refs/heads/" + branch and ref["object"]["sha"] == head for ref in refs):
                raise Hold("Candidate creation could not be confirmed; inspect recovery URL")
    print("Retained docs candidate: https://github.com/" + REPO + "/tree/" + branch, flush=True)
    prs = api.pulls(branch)
    if not prs:
        try:
            created = api.repo("pulls", method="POST", data={
                "head": branch, "base": "main", "title": "chore(sync): mirror validated docs",
                "body": f"Source: {os.environ['GITHUB_REPOSITORY']}@{source_sha}\n"
                        f"Prepared head: {head}\nTarget base: {base}\nOwned tree: {digest}\n\n"
                        "Validated by the source docs publisher. Publication is incomplete until "
                        "target Actions admission and the exact merged-tree receipt succeed."})
            prs = [created]
        except Hold:
            prs = api.pulls(branch)
    if len(prs) != 1:
        raise Hold("Could not confirm one candidate PR; inspect retained branch")
    number = prs[0]["number"]
    print(f"Docs mirror PR: https://github.com/{REPO}/pull/{number}", flush=True)
    for _ in range(30):
        pr = api.repo(f"pulls/{number}")
        if pr["head"]["sha"] != head or pr["base"]["ref"] != "main" or pr["base"]["repo"]["full_name"] != REPO:
            raise Hold("Candidate PR identity changed")
        if pr.get("merged"):
            receipt(pr, head, base, digest)
            return
        if pr["state"] != "open" or pr.get("draft"):
            raise Hold("Candidate PR closed or remains draft; retain payload")
        fresh(base)
        api.admission_rule()
        statuses = api.repo(f"commits/{head}/statuses?per_page=100")
        if len(statuses) >= 100:
            raise Hold("Incomplete candidate status inventory")
        status = next((row for row in statuses if row["context"] == CONTEXT), None)
        admitted = (status and status["state"] == "success"
                    and status["creator"]["login"] == "github-actions[bot]"
                    and status["creator"]["type"] == "Bot")
        if admitted and pr.get("mergeable") is True:
            fresh(base)
            api.admission_rule()
            # No admin/auto-merge path. Strict App-bound server checks close the
            # final base-movement race after our last read, including for a PAT.
            try:
                api.repo(f"pulls/{number}/merge", method="PUT",
                         data={"sha": head, "merge_method": "squash"})
            except Hold:
                pass  # A lost response is reconciled from the authoritative PR.
            receipt(api.repo(f"pulls/{number}"), head, base, digest)
            return
        if status and status["state"] in ("failure", "error"):
            raise Hold("Target publication admission failed; retain PR for inspection")
        if pr.get("mergeable") is False:
            raise Hold("Candidate PR conflicts; retain PR for source revalidation")
        backoff(10)
    raise Hold("Target Actions admission remains pending; retain PR for approval/inspection")


if __name__ == "__main__":
    try:
        mode = sys.argv[-1]
        if mode == "prepare":
            prepare()
        elif mode == "guard":
            GitHub().guard()
        elif mode == "publish":
            publication(GitHub())
        else:
            raise Hold("Unknown docs publisher phase")
    except Hold as error:
        print("Docs publication held: " + str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
