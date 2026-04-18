#!/usr/bin/env python3
"""
PR Review Autofix Pipeline (subscription edition)
==================================================
Reads unresolved review comments on a GitHub PR, uses Claude to generate
targeted fixes, commits them to the PR branch, and posts a summary comment.

Credentials:
    Defaults to the operator's Claude.ai subscription via the Claude Agent
    SDK CLI (`node_modules/@anthropic-ai/claude-agent-sdk/cli.js`). No
    metered API billing; requests count against the operator's Pro/Max
    quota. Same path OpenClaw's `runtime.type: "claude-sdk"` uses.

    Set AUTOFIX_AUTH_MODE=api-key to use ANTHROPIC_API_KEY instead (legacy
    path; metered).

Usage:
    python autofix.py --repo owner/repo --pr 123
    python autofix.py --repo owner/repo --pr 123 --dry-run   # preview only

Env vars:
    GITHUB_TOKEN         - required; GitHub PAT with repo scope
    AUTOFIX_AUTH_MODE    - optional; "subscription" (default) or "api-key"
    ANTHROPIC_API_KEY    - required IFF AUTOFIX_AUTH_MODE=api-key
    AUTOFIX_MODEL        - optional; default "claude-sonnet-4-5-20250929"
    AUTOFIX_MAX_FILES    - optional; max files to patch per run (default 10)
    AUTOFIX_VERIFY_CMD   - optional; shell command to run after patching
                           (e.g. "pnpm check"). Non-zero exit => no push.
    AUTOFIX_MAX_CONSEC   - optional; refuse to run if the last N commits
                           on the branch are autofix commits (default 3).
                           Stops runaway ping-pong between autofixer and
                           review tools.
    AUTOFIX_CLAUDE_TIMEOUT - optional; Claude SDK subprocess timeout in
                           seconds (default 600).
"""

import argparse
import base64
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

GITHUB_API = "https://api.github.com"
ANTHROPIC_API = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-sonnet-4-5-20250929"
MODEL = os.getenv("AUTOFIX_MODEL", DEFAULT_MODEL)
MAX_FILES = int(os.getenv("AUTOFIX_MAX_FILES", "10"))
AUTH_MODE = os.getenv("AUTOFIX_AUTH_MODE", "subscription").strip().lower()
VERIFY_CMD = os.getenv("AUTOFIX_VERIFY_CMD", "").strip()
MAX_CONSEC = int(os.getenv("AUTOFIX_MAX_CONSEC", "3"))
CLAUDE_TIMEOUT = int(os.getenv("AUTOFIX_CLAUDE_TIMEOUT", "600"))


@dataclass
class ReviewComment:
    id: int
    path: str
    line: Optional[int]
    side: str
    body: str
    user: str
    diff_hunk: str
    created_at: str
    in_reply_to_id: Optional[int] = None


@dataclass
class FilePatch:
    path: str
    original: str
    patched: str
    comments_addressed: list = field(default_factory=list)
    explanation: str = ""


# ---------------------------------------------------------------------------
# GitHub API
# ---------------------------------------------------------------------------

def gh_request(endpoint, method="GET", data=None, *, retries=3, quiet_codes=()):
    """GitHub API with retry on transient 5xx/429.

    Args:
        quiet_codes: HTTP status codes the caller handles gracefully
            (e.g. 403 on cross-fork PR comment writes when the fine-
            grained PAT doesn't have write access to the base repo).
            The raw response body is NOT printed to stderr for these;
            the error is still raised so callers can soft-fail."""
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        sys.exit("ERROR: GITHUB_TOKEN env var is required")
    url = f"{GITHUB_API}{endpoint}" if endpoint.startswith("/") else endpoint
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    body = json.dumps(data).encode() if data else None
    if body:
        headers["Content-Type"] = "application/json"
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2 ** attempt)
                last_err = e
                continue
            if e.code not in quiet_codes:
                print(f"GitHub API error {e.code} on {url}: {e.read().decode()}", file=sys.stderr)
            raise
        except urllib.error.URLError as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                last_err = e
                continue
            raise
    raise last_err or RuntimeError("gh_request retries exhausted")


def gh_paginate(endpoint):
    results, page = [], 1
    while True:
        sep = "&" if "?" in endpoint else "?"
        batch = gh_request(f"{endpoint}{sep}per_page=100&page={page}")
        if not batch:
            break
        results.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return results


def fetch_review_comments(repo, pr):
    raw = gh_paginate(f"/repos/{repo}/pulls/{pr}/comments")
    return [
        ReviewComment(
            id=c["id"],
            path=c["path"],
            line=c.get("line") or c.get("original_line"),
            side=c.get("side", "RIGHT"),
            body=c["body"],
            user=c["user"]["login"],
            diff_hunk=c.get("diff_hunk", ""),
            created_at=c["created_at"],
            in_reply_to_id=c.get("in_reply_to_id"),
        )
        for c in raw
    ]


def fetch_pr_info(repo, pr):
    return gh_request(f"/repos/{repo}/pulls/{pr}")


def fetch_recent_commits(repo, branch, limit=10):
    return gh_request(f"/repos/{repo}/commits?sha={branch}&per_page={limit}")


def fetch_file_content(repo, ref, path):
    data = gh_request(f"/repos/{repo}/contents/{path}?ref={ref}")
    if data.get("encoding") == "base64":
        return base64.b64decode(data["content"]).decode("utf-8", errors="replace")
    return data.get("content", "")


def post_pr_comment(repo, pr, body):
    """Post an issue comment to a PR. Soft-fails on 403/404 -- common
    when the token lacks write access to the base repo on a cross-fork
    PR (fine-grained PATs can't be scoped to repos the user doesn't
    own or collaborate on)."""
    try:
        gh_request(
            f"/repos/{repo}/issues/{pr}/comments",
            method="POST",
            data={"body": body},
            quiet_codes=(403, 404),
        )
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            print(
                f"autofix: cannot post comment to {repo}#{pr} (HTTP {e.code}); "
                "token lacks write on base repo. Summary comment skipped.",
                file=sys.stderr,
            )
            return
        raise


def reply_to_review_comment(repo, pr, comment_id, body):
    try:
        gh_request(
            f"/repos/{repo}/pulls/{pr}/comments/{comment_id}/replies",
            method="POST",
            data={"body": body},
            quiet_codes=(403, 404),
        )
    except Exception as e:
        print(f"(non-fatal) could not reply to comment {comment_id}: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Claude call — subscription (default) or api-key
# ---------------------------------------------------------------------------

def call_claude(system: str, user_msg: str) -> str:
    if AUTH_MODE == "api-key":
        return _call_claude_api_key(system, user_msg)
    return _call_claude_subscription(system, user_msg)


def _call_claude_api_key(system: str, user_msg: str, *, retries: int = 4) -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("ERROR: ANTHROPIC_API_KEY required when AUTOFIX_AUTH_MODE=api-key")
    payload = json.dumps(
        {
            "model": MODEL,
            "max_tokens": 8192,
            "system": system,
            "messages": [{"role": "user", "content": user_msg}],
        }
    ).encode()
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(
            ANTHROPIC_API, data=payload, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.loads(resp.read().decode())
            for block in result.get("content", []):
                if block.get("type") == "text":
                    return block.get("text", "")
            return ""
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) and attempt < retries - 1:
                wait = 2 ** attempt
                print(
                    f"Claude API {e.code}; retrying in {wait}s (attempt {attempt + 1}/{retries})",
                    file=sys.stderr,
                )
                time.sleep(wait)
                last_err = e
                continue
            print(f"Claude API error {e.code}: {e.read().decode()}", file=sys.stderr)
            raise
        except urllib.error.URLError as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                last_err = e
                continue
            raise
    raise last_err or RuntimeError("_call_claude_api_key retries exhausted")


def _call_claude_subscription(system: str, user_msg: str) -> str:
    """Run Claude via the Agent SDK subprocess against the operator's
    `claude login` session. Non-interactive: feeds the prompt via stdin
    and collects stdout. No metered billing.

    We feed the prompt through stdin (not via -p <prompt>) because Windows
    has a ~32 KB command-line length limit, and large source files plus
    review-comment context easily blow past it (observed as WinError 206:
    "The filename or extension is too long"). The Agent SDK CLI detects
    piped stdin and enters non-interactive print mode automatically; -p
    is passed as a belt-and-suspenders hint."""
    node_bin = _resolve_node_bin()
    sdk_cli = _resolve_sdk_cli()
    prompt = f"{system}\n\n---\n\n{user_msg}"
    proc = subprocess.run(
        [
            node_bin,
            sdk_cli,
            "-p",
            "--model",
            MODEL,
            "--output-format",
            "text",
        ],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=CLAUDE_TIMEOUT,
        check=False,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        print(f"Agent SDK subprocess exited {proc.returncode}", file=sys.stderr)
        print(f"stderr: {proc.stderr[:2000]}", file=sys.stderr)
        raise RuntimeError(f"Claude Agent SDK failed (exit {proc.returncode})")
    return proc.stdout


def _resolve_node_bin() -> str:
    """Resolve the full path to the `node` executable.

    Relying on subprocess's PATH search is fragile on Windows:
    Microsoft Store Python and other sandboxed builds can miss system
    node.exe even when the parent shell finds it fine, because the
    child process's PATH resolution differs. Resolving to an absolute
    path via shutil.which first, then a short list of standard install
    locations, removes that failure mode."""
    resolved = shutil.which("node")
    if resolved:
        return resolved
    for candidate in (
        Path("C:/Program Files/nodejs/node.exe"),
        Path("C:/Program Files (x86)/nodejs/node.exe"),
        Path("/usr/local/bin/node"),
        Path("/usr/bin/node"),
        Path("/opt/homebrew/bin/node"),
    ):
        if candidate.exists():
            return str(candidate)
    sys.exit(
        "ERROR: could not locate `node`. Install Node.js 22 LTS from "
        "https://nodejs.org/en/download and restart your shell "
        "(or set AUTOFIX_AUTH_MODE=api-key to use the metered HTTP path)."
    )


def _resolve_sdk_cli() -> str:
    repo_candidate = Path("node_modules/@anthropic-ai/claude-agent-sdk/cli.js")
    if repo_candidate.exists():
        return str(repo_candidate.resolve())
    home = Path.home()
    for candidate in (
        home / "AppData" / "Roaming" / "npm" / "node_modules" / "@anthropic-ai" / "claude-agent-sdk" / "cli.js",
        Path("/usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk/cli.js"),
        Path("/usr/lib/node_modules/@anthropic-ai/claude-agent-sdk/cli.js"),
    ):
        if candidate.exists():
            return str(candidate)
    sys.exit(
        "ERROR: could not find @anthropic-ai/claude-agent-sdk/cli.js. "
        "Run `pnpm install` in the repo (or install globally) first."
    )


# ---------------------------------------------------------------------------
# Patch generation
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are an expert code reviewer fix agent. You receive a source file "
    "and review comments. Produce the MINIMAL corrected version. Only change "
    "lines related to comments. Preserve existing style, indentation, and "
    "whitespace. Respond with ONLY a JSON object in this exact shape — no "
    "prose, no code fences, no markdown:\n\n"
    "{\n"
    '  "patched_file": "<complete file contents as a string>",\n'
    '  "explanation": "<one-sentence summary of what changed>",\n'
    '  "comments_addressed": [<list of comment id integers you addressed>]\n'
    "}\n\n"
    "If no change is needed, respond with exactly: "
    '{"patched_file":null,"explanation":"no change needed","comments_addressed":[]}'
)


def generate_fix(path: str, original: str, comments: list[ReviewComment]) -> Optional[FilePatch]:
    comment_block = "\n\n".join(
        f"### Comment by @{c.user} (line {c.line}) id={c.id}\n"
        f"Diff context:\n```\n{c.diff_hunk}\n```\n"
        f"Comment:\n{c.body}"
        for c in comments
    )
    user_msg = (
        f"## File: `{path}`\n\n```\n{original}\n```\n\n"
        f"## Review Comments\n\n{comment_block}\n\n"
        f"Comment IDs: {[c.id for c in comments]}\n\n"
        "Generate the fix now."
    )
    raw = call_claude(SYSTEM_PROMPT, user_msg)
    parsed = _parse_fix_response(raw)
    if parsed is None:
        print(f"WARNING: could not parse Claude response for {path}", file=sys.stderr)
        return None
    patched = parsed.get("patched_file")
    if not patched or not isinstance(patched, str):
        return None
    if patched.strip() == original.strip():
        return None
    return FilePatch(
        path=path,
        original=original,
        patched=patched,
        comments_addressed=[
            cid for cid in parsed.get("comments_addressed", []) if isinstance(cid, int)
        ] or [c.id for c in comments],
        explanation=parsed.get("explanation", ""),
    )


def _parse_fix_response(raw: str) -> Optional[dict]:
    """Parse Claude's JSON response, tolerant of prose and fences."""
    text = raw.strip()
    fence = re.match(r"^```(?:json)?\s*\n(.*?)\n```\s*$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


# ---------------------------------------------------------------------------
# Ping-pong safety: refuse to run if last N commits are all autofix
# ---------------------------------------------------------------------------

def check_autofix_loop(repo: str, branch: str) -> Optional[str]:
    """Returns an error message if the last MAX_CONSEC commits on `branch`
    were all authored by the autofix bot (indicating a probable ping-pong
    with a reviewer). Returns None if safe to proceed.

    We check the git-level author identity (set by apply_patches to
    `PR Autofix Bot <autofix-bot@users.noreply.github.com>`) rather than
    commit-message prefix matching -- humans write "autofix:"-prefixed
    commits too and we don't want those to block the pipeline."""
    if MAX_CONSEC <= 0:
        return None
    try:
        commits = fetch_recent_commits(repo, branch, limit=MAX_CONSEC)
    except Exception as e:
        # Soft-fail: if we can't check, don't block.
        print(f"autofix: could not check commit history: {e}", file=sys.stderr)
        return None
    if len(commits) < MAX_CONSEC:
        return None
    for commit in commits:
        author = ((commit.get("commit") or {}).get("author") or {})
        name = author.get("name", "")
        email = author.get("email", "")
        if name != "PR Autofix Bot" and not email.startswith("autofix-bot@"):
            return None
    return (
        f"autofix: refusing to run -- the last {MAX_CONSEC} commits on `{branch}` "
        "were all authored by the autofix bot, which usually means the fixer "
        "is caught in a ping-pong with a reviewer. Human review required."
    )


# ---------------------------------------------------------------------------
# Apply, verify, push
# ---------------------------------------------------------------------------

def git(*args, cwd=None, check=False):
    result = subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd)
    if check and result.returncode != 0:
        print(f"git {' '.join(args)} failed:\n{result.stderr}", file=sys.stderr)
        raise RuntimeError(f"git {args[0]} failed")
    return result


def _force_rmtree(path: Path) -> None:
    """Remove a directory tree, handling the Windows read-only-file case.

    Git's object store marks `.git/objects/pack/*.pack` (and some others)
    read-only. `shutil.rmtree` then fails on Windows with PermissionError
    when trying to unlink them. `ignore_errors=True` silently leaves a
    partial tree, which is worse -- the next `git clone` into the same
    path fails with "destination path already exists and is not empty."
    The onerror callback below unsets read-only and retries the unlink
    so the tree actually goes away."""

    def _on_error(func, target, _exc_info):
        try:
            os.chmod(target, stat.S_IWRITE | stat.S_IREAD)
        except OSError:
            pass
        try:
            func(target)
        except OSError:
            pass

    try:
        shutil.rmtree(path, onerror=_on_error)
    except FileNotFoundError:
        return


def _sweep_stale_autofix_work_dirs(tmp_base: Path) -> None:
    """Best-effort cleanup of leftover autofix-work-* directories from
    crashed previous runs. Safe no-op if nothing matches."""
    try:
        for child in tmp_base.iterdir():
            if child.is_dir() and child.name.startswith("autofix-work"):
                _force_rmtree(child)
    except OSError:
        pass


def apply_patches(repo: str, branch: str, head_sha: str, patches: list[FilePatch], dry_run: bool) -> bool:
    if dry_run:
        for p in patches:
            print(f"\n--- {p.path} ---")
            print(f"  {p.explanation}")
            print(f"  comments_addressed: {p.comments_addressed}")
        return True

    # Use RUNNER_TEMP (GitHub Actions) or the standard platform temp dir.
    # /tmp doesn't exist on Windows, so prefer TEMP/TMPDIR first before
    # falling back.
    tmp_base_str = (
        os.environ.get("RUNNER_TEMP")
        or os.environ.get("TEMP")
        or os.environ.get("TMPDIR")
        or "/tmp"
    )
    tmp_base = Path(tmp_base_str)
    tmp_base.mkdir(parents=True, exist_ok=True)

    # Sweep any leftover autofix-work-* dirs from crashed previous runs
    # so they don't pile up in %TEMP% over time.
    _sweep_stale_autofix_work_dirs(tmp_base)

    # Use a unique mkdtemp-assigned directory per run. Previously we used
    # a fixed `autofix-work` dir that we tried to clear with
    # `shutil.rmtree(ignore_errors=True)`; on Windows the git pack files
    # are read-only and rmtree silently left partial content behind,
    # causing the next `git clone` to fail with "destination path
    # already exists and is not an empty directory." mkdtemp sidesteps
    # the race entirely -- a fresh unique name every run.
    work_dir = Path(tempfile.mkdtemp(prefix="autofix-work-", dir=str(tmp_base)))

    # Wrap the rest in try/finally so we always attempt cleanup on exit,
    # even on push failure or unexpected exception.
    try:
        token = os.environ["GITHUB_TOKEN"]
        clone_result = git(
            "clone",
            "--depth=1",
            "--branch",
            branch,
            f"https://x-access-token:{token}@github.com/{repo}.git",
            str(work_dir),
        )
        if clone_result.returncode != 0:
            print(f"git clone failed: {clone_result.stderr}", file=sys.stderr)
            return False

        # Verify that the cloned HEAD matches the SHA the patches were
        # generated against. If not, the branch advanced while we were
        # running -- abort to avoid clobbering newer commits.
        head_check = git("rev-parse", "HEAD", cwd=str(work_dir))
        if head_check.returncode != 0:
            print(f"autofix: could not read HEAD: {head_check.stderr}", file=sys.stderr)
            return False
        cloned_sha = head_check.stdout.strip()
        if cloned_sha != head_sha:
            print(
                f"autofix: branch {branch} advanced from {head_sha[:7]} to {cloned_sha[:7]} "
                "while patches were being generated; aborting to avoid clobbering newer commits.",
                file=sys.stderr,
            )
            return False

        # Set the commit identity locally in case the caller's global git
        # config isn't set (common on fresh CI runners; no-op otherwise
        # since local config overrides global only when set).
        git("config", "user.name", "PR Autofix Bot", cwd=str(work_dir))
        git("config", "user.email", "autofix-bot@users.noreply.github.com", cwd=str(work_dir))

        for patch in patches:
            fp = work_dir / patch.path
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(patch.patched, encoding="utf-8")
            git("add", patch.path, cwd=str(work_dir), check=True)

        diff_check = git("diff", "--cached", "--quiet", cwd=str(work_dir))
        if diff_check.returncode == 0:
            print("autofix: no effective diff after applying patches", file=sys.stderr)
            return False

        if VERIFY_CMD:
            print(f"autofix: running verification command `{VERIFY_CMD}` before push...")
            verify = subprocess.run(
                VERIFY_CMD, shell=True, cwd=str(work_dir), capture_output=True, text=True
            )
            if verify.returncode != 0:
                print(
                    f"autofix: verification failed (exit {verify.returncode}); "
                    "NOT pushing the fix.",
                    file=sys.stderr,
                )
                print(verify.stdout[-2000:], file=sys.stderr)
                print(verify.stderr[-2000:], file=sys.stderr)
                return False

        msg = (
            f"autofix: address {sum(len(p.comments_addressed) for p in patches)} "
            f"review comments\n\nGenerated by PR Autofix Pipeline\n"
            "Co-Authored-By: Claude <noreply@anthropic.com>"
        )
        commit = git("commit", "-m", msg, cwd=str(work_dir))
        if commit.returncode != 0:
            print(f"autofix: nothing to commit: {commit.stderr}", file=sys.stderr)
            return False

        push = git("push", "origin", branch, cwd=str(work_dir))
        if push.returncode != 0:
            print(f"autofix: push failed: {push.stderr}", file=sys.stderr)
            return False
        return True
    finally:
        _force_rmtree(work_dir)


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def run_pipeline(repo: str, pr: int, dry_run: bool = False) -> int:
    pr_info = fetch_pr_info(repo, pr)
    head_ref = pr_info["head"]["ref"]
    head_sha = pr_info["head"]["sha"]
    head_repo = pr_info["head"]["repo"]["full_name"]
    # The PR's branch lives on `head_repo`, which may be a fork of `repo`.
    # Push commits to head_repo (requires GITHUB_TOKEN to have write access
    # there -- for your own fork that's just your PAT with repo scope).
    # Comments/replies still go to `repo` (that's where the PR itself lives).
    if head_repo != repo:
        print(
            f"autofix: PR head is on fork {head_repo}; pushing fixes there "
            f"(base repo {repo} is used for PR comments only).",
            file=sys.stderr,
        )

    loop_error = check_autofix_loop(head_repo, head_ref)
    if loop_error:
        print(loop_error, file=sys.stderr)
        try:
            post_pr_comment(repo, pr, f"## Autofix paused\n\n{loop_error}")
        except Exception:
            pass
        return 0

    comments = fetch_review_comments(repo, pr)
    top_comments = [c for c in comments if c.in_reply_to_id is None]
    if not top_comments:
        print("autofix: no top-level review comments to fix.")
        return 0

    by_file: dict[str, list[ReviewComment]] = {}
    for c in top_comments:
        by_file.setdefault(c.path, []).append(c)

    prioritized = sorted(by_file.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    capped = prioritized[:MAX_FILES]

    patches: list[FilePatch] = []
    for path, fc in capped:
        try:
            original = fetch_file_content(head_repo, head_sha, path)
        except Exception as e:
            print(f"autofix: could not fetch {path}@{head_sha}: {e}", file=sys.stderr)
            continue
        try:
            patch = generate_fix(path, original, fc)
        except Exception as e:
            print(f"autofix: generate_fix failed for {path}: {e}", file=sys.stderr)
            continue
        if patch:
            patches.append(patch)

    if not patches:
        print("autofix: no patches generated.")
        return 0

    success = apply_patches(head_repo, head_ref, head_sha, patches, dry_run)
    if not success or dry_run:
        return 0 if dry_run else 1

    summary = (
        "## Autofix Summary\n\n"
        f"Addressed {sum(len(p.comments_addressed) for p in patches)} comments "
        f"across {len(patches)} file(s).\n\n"
        + "\n".join(f"- **{p.path}**: {p.explanation}" for p in patches)
    )
    try:
        post_pr_comment(repo, pr, summary)
    except Exception as e:
        print(f"autofix: could not post summary: {e}", file=sys.stderr)

    for p in patches:
        for cid in p.comments_addressed:
            reply_to_review_comment(repo, pr, cid, f"Autofix applied: {p.explanation}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="PR review autofix pipeline")
    parser.add_argument("--repo", required=True, help="owner/repo")
    parser.add_argument("--pr", required=True, type=int, help="PR number")
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview only (no commit, no push)"
    )
    args = parser.parse_args()
    sys.exit(run_pipeline(args.repo, args.pr, args.dry_run))


if __name__ == "__main__":
    main()
