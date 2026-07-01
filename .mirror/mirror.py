#!/usr/bin/env python3
"""
hack_your_workflow mirror engine (generalized).

Replays an upstream repo's pull requests onto a fork so the SAME CI fires on
the fork's tenki runners -- continuous, real-world load on Tenki.

Generalized from the qbit fork mirror:
  * upstream/fork/runner-labels/bases come from a config file (no hard-coding);
  * a baseline high-water mark (`since_pr`) means we mirror the most-recent PR
    and any NEW PRs only -- never the historical back-catalog (bounded load,
    avoids saturating a fork's tenki concurrency);
  * tenkify() rewrites every `runs-on:` (bare, array, or repo-conditional) to
    the tenki pools;
  * decouple() applies a per-repo, idempotent set of transforms so the CI runs
    on tenki without the upstream's private infra (internal registries, secrets,
    DNS) and skips jobs that need capabilities a tenki runner lacks.

Config: <repo-dir>/.mirror/mirror.config.json  (see SKILL.md). Example:
  {
    "upstream": "owner/repo",
    "fork": "hashbender/repo",
    "since_pr": 412,
    "runner_large": "tenki-standard-large-plus-16c-32g",
    "runner_medium": "tenki-standard-medium-4c-8g",
    "pr_ci_bases": ["main"],
    "decouple": {
      "subs": [["find", "replace"]],
      "gate_jobs": ["windows-native-dll"],
      "accept_skipped": true
    }
  }

Usage:
  mirror.py --repo-dir <clone> [--execute] [--reset-bases] [--delay 30]
            [--only N ...] [--ignore-existing] [--prs-file f.json]
The <clone> must have git remotes: origin -> upstream, fork -> fork.
Schedule-only watcher: `--execute` with no `--reset-bases` (continue mode).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

# --- config -----------------------------------------------------------------

REPO_DIR = None
CFG = {}
UPSTREAM = FORK = ""
ORIGIN, FORKREM = "origin", "fork"
TENKI_LARGE = TENKI_MEDIUM = ""
PR_CI_BASES = set()
SINCE_PR = 0
MARKER_T = ""
_RG = ""  # "github.repository == '<upstream>'"


def load_config(repo_dir):
    global CFG, UPSTREAM, FORK, TENKI_LARGE, TENKI_MEDIUM, PR_CI_BASES
    global SINCE_PR, MARKER_T, _RG
    path = os.path.join(repo_dir, ".mirror", "mirror.config.json")
    if not os.path.exists(path):
        sys.exit("missing config: {} (run the hack_your_workflow setup first)".format(path))
    CFG = json.load(open(path, encoding="utf8"))
    UPSTREAM = CFG["upstream"]
    FORK = CFG["fork"]
    TENKI_LARGE = CFG.get("runner_large", "tenki-standard-large-plus-16c-32g")
    TENKI_MEDIUM = CFG.get("runner_medium", "tenki-standard-medium-4c-8g")
    PR_CI_BASES = set(CFG.get("pr_ci_bases", ["main"]))
    SINCE_PR = int(CFG.get("since_pr", 0))
    MARKER_T = "Mirror-of: {}#{{}}".format(UPSTREAM)
    _RG = "github.repository == '{}'".format(UPSTREAM)


# --- shell helpers ----------------------------------------------------------

def git(*a, check=True):
    r = subprocess.run(["git", "-C", REPO_DIR, *a], capture_output=True, text=True)
    if check and r.returncode:
        sys.exit("git {}\n{}".format(" ".join(a), r.stderr or r.stdout))
    return (r.stdout or "").strip()


def gh(*a, check=True):
    r = subprocess.run(["gh", *a], capture_output=True, text=True)
    if check and r.returncode:
        sys.exit("gh {}\n{}".format(" ".join(a), r.stderr or r.stdout))
    return (r.stdout or "").strip()


# --- runner-label rewrite (tenkify) -----------------------------------------
# self-hosted / qbit-trusted-ci style expressions -> large pool;
# bare hosted labels and repo-conditional hosted expressions -> medium pool.

_EXPR = re.compile(r"\$\{\{[^}]*github\.repository[^}]*self-hosted[^}]*\}\}")
_ARR = re.compile(r"(runs-on:\s*)\[\s*self-hosted[^\]]*\]")
_HOSTED = re.compile(r"(runs-on:\s*)(?:ubuntu|macos|windows|blacksmith)-[\w.\-]+")
# runs-on as a repo-conditional expression resolving to a hosted/blacksmith
# label (no self-hosted), e.g. ${{ ... && 'blacksmith-...' || 'windows-2022' }}.
_EXPR_HOSTED = re.compile(r"(runs-on:\s*)\$\{\{[^}]*(?:ubuntu|macos|windows|blacksmith)-[^}]*\}\}")


def tenkify(text):
    text = _EXPR.sub(TENKI_LARGE, text)
    text = _ARR.sub(r"\1" + TENKI_LARGE, text)
    text = _HOSTED.sub(r"\1" + TENKI_MEDIUM, text)
    text = _EXPR_HOSTED.sub(r"\1" + TENKI_MEDIUM, text)
    text = decouple(text)
    return text


# --- decouple from the upstream's private CI infra (config-driven) ----------
# All transforms are IDEMPOTENT: tenkify() runs many times per mirror pass
# (base reconstruct + every PR overlay), so re-applying must be a no-op.

def _gate_with_if(text, key):
    # Prepend the repo gate to a job's existing top-level `if:` (skip on forks).
    pat = re.compile(r"(\n  " + re.escape(key) + r":\n(?:    [^\n]*\n)*?    if: \$\{\{ )(?!" + re.escape(_RG) + ")")
    return pat.sub(r"\1" + _RG + " && ", text, count=1)


def _gate_add_if(text, key):
    # Add a top-level `if:` (skip on forks) as the job's first property. Works
    # whether or not the job has a `name:`. Idempotent and a no-op when the job
    # already has a top-level `if:` (which _gate_with_if will have gated).
    m = re.search(r"\n  " + re.escape(key) + r":\n", text)
    if not m:
        return text
    start = m.end()
    nxt = re.search(r"\n  \S", text[start:])              # next top-level job key
    block = text[start:start + nxt.start()] if nxt else text[start:]
    if re.search(r"^    if:", block, re.M):                # already has a job-level if
        return text
    return text[:start] + "    if: ${{ " + _RG + " }}\n" + text[start:]


def decouple(text):
    dc = CFG.get("decouple", {}) or {}
    # 1) literal find/replace subs (registries, DNS, tracing flags, matrix
    #    step-skips, ...). The skill writes these to be self-idempotent: the
    #    `find` must not occur inside its own `replace`.
    for find, repl in dc.get("subs", []):
        text = text.replace(find, repl)
    # 2) gate jobs to the canonical (upstream) repo so they skip on the fork.
    for key in dc.get("gate_jobs", []):
        text = _gate_with_if(text, key)
        text = _gate_add_if(text, key)
    # 3) make aggregate gates treat a skipped (gated-off) job as a pass.
    if dc.get("accept_skipped"):
        text = text.replace(
            'if [[ "${result}" != "success" ]]; then',
            'if [[ "${result}" != "success" && "${result}" != "skipped" ]]; then')
    return text


def tenkify_workflows():
    wf, root = [], os.path.join(REPO_DIR, ".github", "workflows")
    if not os.path.isdir(root):
        return wf
    for name in sorted(os.listdir(root)):
        if not name.endswith((".yml", ".yaml")):
            continue
        p = os.path.join(root, name)
        old = open(p, encoding="utf8").read()
        new = tenkify(old)
        assert_decoupled(new, p)
        if new != old:
            open(p, "w", encoding="utf8").write(new)
            wf.append(os.path.relpath(p, REPO_DIR))
    return wf


def assert_decoupled(text, path):
    # Fail loudly if a required decouple sub stopped matching (upstream drift).
    for marker in (CFG.get("decouple", {}) or {}).get("assert_absent", []):
        if marker in text:
            sys.exit("{}: decouple incomplete (upstream drift?): still contains {!r}"
                     .format(path, marker))


def assert_tenki(ctx):
    bad = []
    for line in git("grep", "-h", "-E", "runs-on:", "--", ".github/workflows/").splitlines():
        v = line.split("runs-on:", 1)[1].strip()
        v = re.sub(r"^&\w+\s*", "", v)
        if v == "" or v.startswith("*") or v.startswith("tenki-"):
            continue
        if "self-hosted" in v or "github.repository" in v or re.search(r"(ubuntu|macos|windows|blacksmith)-", v):
            bad.append(line)
    if bad:
        sys.exit("{}: non-tenki runs-on remains:\n  {}".format(ctx, "\n  ".join(bad)))


# --- upstream data ----------------------------------------------------------

def pr_files(n):
    out = gh("api", "repos/{}/pulls/{}/files".format(UPSTREAM, n), "--paginate",
             "-q", '.[] | [.status, .filename, (.previous_filename // "")] | @tsv')
    rows = []
    for line in out.splitlines():
        parts = line.split("\t")
        rows.append((parts[0], parts[1], parts[2] if len(parts) > 2 else ""))
    return rows


def first_commit_parent(n):
    oid = gh("pr", "view", str(n), "--repo", UPSTREAM, "--json", "commits",
             "-q", ".commits[0].oid")
    return oid + "^"


def _ref_has(ref, path):
    return subprocess.run(["git", "-C", REPO_DIR, "cat-file", "-e", "{}:{}".format(ref, path)],
                          capture_output=True).returncode == 0


CI_PROBE = ".github/workflows"


def _pick_start(base, first_pr, all_prs):
    """Choose a base's start commit so code stays coherent with its workflows.
    Historical pre-PR point if it already has workflows (or a mirrored PR adds
    them); else the current upstream tip."""
    hist = first_commit_parent(first_pr["number"])
    if _ref_has(hist, ".github/workflows/ci.yml") or _ref_has(hist, ".github"):
        return hist, "historical"
    tip = "{}/{}".format(ORIGIN, base)
    if subprocess.run(["git", "-C", REPO_DIR, "rev-parse", "-q", "--verify", tip],
                      capture_output=True).returncode == 0:
        return tip, "current-tip"
    return hist, "historical(no-CI)"


# --- build steps ------------------------------------------------------------

def build_overlay(src_ref, head_ref, files, msg):
    git("checkout", "--quiet", "--detach", src_ref)
    for status, path, prev in files:
        if status == "removed":
            git("rm", "-q", "-f", "--ignore-unmatch", "--", path, check=False)
        elif status == "renamed":
            if prev:
                git("rm", "-q", "-f", "--ignore-unmatch", "--", prev, check=False)
            git("checkout", head_ref, "--", path)
        else:
            git("checkout", head_ref, "--", path)
    wf = tenkify_workflows()
    assert_tenki(msg)
    git("add", "-A")
    if not git("diff", "--cached", "--name-only"):
        return None, 0, 0
    n = len(git("diff", "--cached", "--name-only").splitlines())
    git("commit", "--quiet", "-m", msg)
    return git("rev-parse", "HEAD"), n, len(wf)


# --- fork PR state ----------------------------------------------------------

def existing_mirrors():
    out = gh("pr", "list", "--repo", FORK, "--state", "all", "--limit", "300",
             "--json", "number,body,state")
    pat = re.compile(re.escape(MARKER_T).replace(r"\{\}", r"(\d+)"))
    mp = {}
    for p in json.loads(out or "[]"):
        m = pat.search(p.get("body") or "")
        if not m:
            continue
        k, cur = int(m.group(1)), mp.get(int(m.group(1)))
        if (cur is None
                or (p["state"] == "OPEN") > (cur["state"] == "OPEN")
                or ((p["state"] == "OPEN") == (cur["state"] == "OPEN")
                    and p["number"] > cur["number"])):
            mp[k] = p
    return mp


# --- base reconstruction ----------------------------------------------------

def _reconstruct_base(b, first, all_prs, ex, verb, log):
    start, mode = _pick_start(b, first, all_prs)
    git("checkout", "--quiet", "--detach", start)
    wf = tenkify_workflows()
    assert_tenki("base " + b)
    if wf:
        git("add", "-A")
        git("commit", "--quiet", "-m",
            "ci: tenki runner labels for {} (mirror base)".format(b))
    sha = git("rev-parse", "HEAD")
    log("  {:<26} {} {} (+{} wf)  [{}]".format(b, verb, sha[:10], len(wf), mode))
    if ex:
        git("push", "--force", FORKREM, "{}:refs/heads/{}".format(sha, b))
    return sha


# --- main -------------------------------------------------------------------

def main():
    global REPO_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-dir", required=True)
    ap.add_argument("--prs-file", help="JSON from gh pr list; else fetched live")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--reset-bases", action="store_true",
                    help="force-reset base branches to their pre-PR start "
                         "(setup/backfill only; never the scheduled watcher)")
    ap.add_argument("--only", type=int, nargs="*", help="replay only these PR numbers")
    ap.add_argument("--ignore-existing", action="store_true",
                    help="re-mirror PRs even if a marker already exists on the fork")
    ap.add_argument("--delay", type=float, default=0)
    args = ap.parse_args()
    REPO_DIR = args.repo_dir
    load_config(REPO_DIR)
    ex = args.execute

    def log(m):
        print(m, flush=True)

    log("== {} -> {}  (since PR #{}) ==".format(UPSTREAM, FORK, SINCE_PR))
    log("== fetch ==")
    git("fetch", "--quiet", ORIGIN, "+refs/heads/*:refs/remotes/origin/*",
        "+refs/pull/*/head:refs/mirror-src/pr/*")
    git("fetch", "--quiet", FORKREM, "+refs/heads/*:refs/remotes/fork/*")

    if args.prs_file:
        prs = json.load(open(args.prs_file, encoding="utf8"))
    else:
        prs = json.loads(gh("pr", "list", "--repo", UPSTREAM, "--state", "all",
              "--limit", "100", "--json",
              "number,title,body,state,baseRefName,headRefName,mergedAt,createdAt,url"))
    # Baseline: only the most-recent PR and newer (no historical backfill).
    prs = [p for p in prs if p["number"] >= SINCE_PR]
    prs.sort(key=lambda p: p["createdAt"])
    all_prs = list(prs)
    bases = {}
    for p in prs:
        bases.setdefault(p["baseRefName"], p)
    if args.only:
        prs = [p for p in prs if p["number"] in args.only]

    mirrors = existing_mirrors() if ex else {}

    log("\n== bases ({}) ==  [{}{}]".format(
        len(bases), "EXECUTE" if ex else "dry-run", ", RESET" if args.reset_bases else ""))
    evolving = {}
    for b, first in bases.items():
        if args.reset_bases:
            evolving[b] = _reconstruct_base(b, first, all_prs, ex, "start", log)
            continue
        ref = "fork/" + b
        sha = subprocess.run(["git", "-C", REPO_DIR, "rev-parse", "-q", "--verify", ref],
                             capture_output=True, text=True).stdout.strip()
        if sha:
            evolving[b] = sha
            log("  {:<26} continue {}".format(b, sha[:10]))
        else:
            # A new upstream base not yet on the fork: reconstruct just this one
            # instead of bailing for a full --reset-bases. Existing bases untouched.
            evolving[b] = _reconstruct_base(b, first, all_prs, ex, "create", log)

    log("\n== PRs ({}) ==".format(len(prs)))
    for pr in prs:
        n, b, st = pr["number"], pr["baseRefName"], pr["state"]
        head = "refs/mirror-src/pr/{}".format(n)

        if ex and n in mirrors and not args.ignore_existing:
            fp = mirrors[n]
            if fp["state"] == "OPEN" and st in ("MERGED", "CLOSED"):
                log("  #{:<3} already #{} OPEN -> sync {}".format(n, fp["number"], st))
                _drive_state(st, str(fp["number"]), b, evolving, ex, log)
            else:
                log("  #{:<3} already #{} ({}) -- skip".format(n, fp["number"], fp["state"]))
            continue

        files = pr_files(n)
        sha, nfiles, nwf = build_overlay(evolving[b], head, files, pr["title"])
        if sha is None:
            log("  #{:<3} {:<26} EMPTY after tenki rewrite -- skipped".format(n, b))
            continue
        branch = "mirror/pr-{}".format(n)
        git("branch", "-f", branch, sha)
        log("  #{:<3} {:<26} <- {:<30} {:>3} files{}  [{}]".format(
            n, b, pr["headRefName"], nfiles,
            " (+{} wf)".format(nwf) if nwf else "", st))

        if not ex:
            if st == "MERGED":
                evolving[b] = sha
            continue

        git("push", "--force", FORKREM, "{}:refs/heads/{}".format(sha, branch))
        body = "{}\n\n---\n{}\n{}".format((pr.get("body") or "").strip(),
                                          MARKER_T.format(n), pr["url"])
        url = gh("pr", "create", "--repo", FORK, "--base", b, "--head", branch,
                 "--title", pr["title"], "--body", body)
        log("       opened {}".format(url))
        if st == "MERGED" and b in PR_CI_BASES:
            _wait_for_pr_run(branch, sha, log)
        _drive_state(st, url, b, evolving, ex, log)
        if args.delay:
            time.sleep(args.delay)

    log("\nDone ({}).".format("executed" if ex else "dry-run, nothing pushed"))


def _wait_for_pr_run(branch, sha, log, timeout=90):
    waited = 0
    while waited < timeout:
        out = gh("run", "list", "--repo", FORK, "--branch", branch, "--event",
                 "pull_request", "--limit", "10", "--json", "headSha", check=False)
        if any(r.get("headSha", "").startswith(sha[:12]) for r in json.loads(out or "[]")):
            log("       pull_request CI spawned ({}s)".format(waited))
            return
        time.sleep(6)
        waited += 6
    log("       (no pull_request run after {}s; continuing)".format(timeout))


def _drive_state(state, ref, base, evolving, ex, log):
    if state == "MERGED":
        last = ""
        for _ in range(6):
            r = subprocess.run(["gh", "pr", "merge", ref, "--repo", FORK, "--squash"],
                               capture_output=True, text=True)
            if r.returncode == 0:
                break
            last = r.stderr or r.stdout
            time.sleep(5)
        else:
            sys.exit("merge {} failed after retries:\n{}".format(ref, last))
        git("fetch", "--quiet", FORKREM, "+refs/heads/{0}:refs/remotes/fork/{0}".format(base))
        evolving[base] = git("rev-parse", "fork/" + base)
        log("       merged (squash); base advanced")
    elif state == "CLOSED":
        gh("pr", "close", ref, "--repo", FORK)
        log("       closed")
    else:
        log("       left open")


if __name__ == "__main__":
    main()
