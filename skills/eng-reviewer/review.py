#!/usr/bin/env python3
"""
eng-reviewer: Review code changes using Gemini Flash.

Usage: review.py <repo_path> <commit_or_ref> <task_id>
Exit:  0 = verdict pass, 1 = verdict fail, 2 = error (API/git failure)

Writes result to <repo_path>/.eng/reviews/<task_id>.json
Also writes to WORKSPACE/.eng/reviews/<task_id>.json if WORKSPACE env var is set.
"""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

GEMINI_MODEL = "gemini-3-flash-preview"
MAX_DIFF_CHARS = 10_000  # truncate huge diffs to stay within token budget


def get_diff(repo_path: str, ref: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", repo_path, "show", "--stat", "--patch", ref],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"git show failed: {result.stderr.strip()}")
        return result.stdout
    except subprocess.TimeoutExpired:
        raise RuntimeError("git show timed out")


def call_gemini(api_key: str, prompt: str) -> str:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={api_key}"
    )
    payload = json.dumps(
        {"contents": [{"parts": [{"text": prompt}]}]}
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    import time
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read())
            last_err = None
            break
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            last_err = RuntimeError(f"Gemini API error {e.code}: {body[:500]}")
            if e.code in (503, 429) and attempt < 2:
                time.sleep(10 * (attempt + 1))  # 10s, 20s
                continue
            raise last_err
    if last_err:
        raise last_err

    try:
        return data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Unexpected Gemini response shape: {e}\n{json.dumps(data)[:500]}")


def parse_verdict(raw: str) -> dict:
    """Extract JSON from Gemini response, stripping markdown fences if present."""
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        # Drop opening fence (```json or ```) and closing fence
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    return json.loads(text)


def write_result(path: str, result: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(result, f, indent=2)


def main() -> int:
    if len(sys.argv) < 4:
        print("Usage: review.py <repo_path> <commit_or_ref> <task_id>", file=sys.stderr)
        return 2

    repo_path = sys.argv[1]
    ref = sys.argv[2]
    task_id = sys.argv[3]
    task_context = sys.argv[4] if len(sys.argv) > 4 else ""

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        secret_path = os.environ.get("GEMINI_API_KEY_PATH", "/run/secrets/gemini_api_key")
        try:
            api_key = open(secret_path).read().strip()
        except OSError:
            pass
    if not api_key:
        print("ERROR: GEMINI_API_KEY is not set and secret file not readable", file=sys.stderr)
        return 2

    # Get diff
    try:
        diff = get_diff(repo_path, ref)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS] + f"\n\n[... diff truncated at {MAX_DIFF_CHARS} chars ...]"

    context_block = ""
    if task_context:
        context_block = f"""
TASK CONTEXT (use this to understand scope and what "done" means):
{task_context}

"""

    prompt = f"""You are a senior code reviewer. Review the following git diff.
{context_block}
Return ONLY valid JSON — no prose, no markdown fences — matching this exact schema:
{{
  "verdict": "pass" | "fail",
  "issues": [
    {{
      "file": "<filename>",
      "line": <line_number_or_0>,
      "severity": "critical" | "major" | "minor",
      "description": "<what the problem is>",
      "suggestion": "<concrete fix>"
    }}
  ],
  "summary": "<1-2 sentence overall assessment>"
}}

Rules:
- verdict = "fail" ONLY if there are critical or major issues
- Minor issues alone → verdict = "pass" (list them but don't fail)
- Security bugs, data loss risks, and broken logic are always critical or major
- Style and naming issues are minor
- Empty issues array is fine if the code is clean
- Judge completeness relative to the TASK CONTEXT above, not against full system implementation

DIFF:
{diff}"""

    # Call Gemini
    try:
        raw = call_gemini(api_key, prompt)
    except RuntimeError as e:
        print(f"ERROR: Gemini call failed: {e}", file=sys.stderr)
        return 2

    # Parse response
    try:
        result = parse_verdict(raw)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"ERROR: Could not parse Gemini response as JSON: {e}", file=sys.stderr)
        print(f"Raw response: {raw[:500]}", file=sys.stderr)
        return 2

    # Validate schema minimally
    if "verdict" not in result or result["verdict"] not in ("pass", "fail"):
        print(f"ERROR: Invalid verdict value: {result.get('verdict')}", file=sys.stderr)
        return 2

    # Write result to repo worktree
    out_path = os.path.join(repo_path, ".eng", "reviews", f"{task_id}.json")
    write_result(out_path, result)

    # Also write to workspace .eng/reviews if WORKSPACE is set
    workspace = os.environ.get("WORKSPACE", "/home/node/.openclaw/workspace-engineering")
    ws_out = os.path.join(workspace, ".eng", "reviews", f"{task_id}.json")
    if ws_out != out_path:
        write_result(ws_out, result)

    # Print to stdout for the orchestrator
    print(json.dumps(result, indent=2))

    verdict = result["verdict"]
    issues = result.get("issues", [])
    summary = result.get("summary", "")
    critical_count = sum(1 for i in issues if i.get("severity") == "critical")
    major_count = sum(1 for i in issues if i.get("severity") == "major")

    print(
        f"\n[eng-reviewer] Verdict: {verdict.upper()} | "
        f"Critical: {critical_count} | Major: {major_count} | "
        f"Total issues: {len(issues)}",
        file=sys.stderr,
    )
    if summary:
        print(f"[eng-reviewer] Summary: {summary}", file=sys.stderr)

    return 0 if verdict == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
