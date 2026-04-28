#!/usr/bin/env python3
import argparse
import json
import re
import sys
from pathlib import Path


ROOT_WORKSPACE = Path("/home/mertb/.openclaw/workspace")
DEFAULT_SESSION_REGISTRY = Path("/home/mertb/.openclaw/agents/codex/sessions/sessions.json")
DEFAULT_OUTPUT_DIR = ROOT_WORKSPACE / ".openclaw" / "codex-queue" / "outbound"


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _load_jsonl(path: Path):
    items = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        items.append(json.loads(line))
    return items


def _normalize_status(status: str | None) -> str:
    raw = (status or "").strip().lower()
    mapping = {
        "done": "success",
        "completed": "success",
        "success": "success",
        "succeeded": "success",
        "failed": "failed",
        "error": "error",
        "cancelled": "cancelled",
        "canceled": "cancelled",
        "timed_out": "timed_out",
        "timeout": "timed_out",
    }
    return mapping.get(raw, raw or "success")


def _extract_message_text(content) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if text:
                    parts.append(str(text).strip())
        return "\n".join(part for part in parts if part).strip()
    return ""


def _summarize(text: str) -> str:
    text = re.sub(r"\s+", " ", text.strip())
    if not text:
        return "Codex run completed."
    sentence_match = re.match(r"(.+?[.!?])(?:\s|$)", text)
    summary = sentence_match.group(1).strip() if sentence_match else text
    return summary[:280].rstrip()


def _extract_modified_files(text: str) -> list[str]:
    matches = re.findall(r"(?<![A-Za-z0-9_./-])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+)(?![A-Za-z0-9_./-])", text)
    filtered = []
    seen = set()
    for match in matches:
        candidate = match.strip("`'\".,:;()[]{}")
        if "/" not in candidate:
            continue
        if candidate.startswith("http/") or candidate.startswith("https/"):
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        filtered.append(candidate)
    return filtered[:20]


def build_raw_result(session_key: str, session_entry: dict, session_file: Path) -> dict:
    messages = _load_jsonl(session_file)
    assistant_messages = [
        item for item in messages if item.get("type") == "message" and item.get("message", {}).get("role") == "assistant"
    ]
    if not assistant_messages:
        raise ValueError(f"No assistant message found in {session_file}")

    final_message = assistant_messages[-1].get("message", {})
    final_text = _extract_message_text(final_message.get("content"))
    if not final_text:
        raise ValueError(f"Assistant final text empty in {session_file}")

    session_id = session_entry.get("sessionId") or session_file.stem
    acp = session_entry.get("acp", {})
    runtime_options = acp.get("runtimeOptions", {})
    runtime_cwd = runtime_options.get("cwd") or session_entry.get("cwd")

    raw_result = {
        "job_id": session_key,
        "status": _normalize_status(session_entry.get("status")),
        "summary": _summarize(final_text),
        "completed_at": session_entry.get("endedAt") and __import__("datetime").datetime.fromtimestamp(session_entry["endedAt"] / 1000, tz=__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
        "sequence": 1,
        "files_changed": _extract_modified_files(final_text),
        "open_questions": [],
        "metadata": {
            "sessionId": session_id,
            "sessionFile": str(session_file),
            "runtimeSessionName": acp.get("runtimeSessionName"),
            "runtimeCwd": runtime_cwd,
            "runtimeMs": session_entry.get("runtimeMs"),
            "spawnedBy": session_entry.get("spawnedBy"),
        },
    }
    if session_entry.get("status") == "failed":
        raw_result["error_details"] = acp.get("lastError") or "Codex session failed."
    return raw_result


def main() -> int:
    parser = argparse.ArgumentParser(description="Bridge a finished Codex ACP session transcript into a raw Codex result JSON.")
    parser.add_argument("--session-key", required=True, help="Key from sessions.json, e.g. agent:codex:acp:...")
    parser.add_argument("--session-registry", default=str(DEFAULT_SESSION_REGISTRY))
    parser.add_argument("--output")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUTPUT_DIR))
    args = parser.parse_args()

    registry_path = Path(args.session_registry)
    registry = _load_json(registry_path)
    session_entry = registry.get(args.session_key)
    if session_entry is None:
        raise SystemExit(f"Session key not found: {args.session_key}")

    session_file = Path(session_entry["sessionFile"])
    raw_result = build_raw_result(args.session_key, session_entry, session_file)

    output_path = Path(args.output) if args.output else Path(args.out_dir) / f"{args.session_key.replace(':', '__')}.result.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(raw_result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(str(output_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
