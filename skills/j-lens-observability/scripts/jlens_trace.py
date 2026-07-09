#!/usr/bin/env python3
"""Summarize prompt/response traces for J-Lens-style observability.

This script does not perform activation-level J-Lens. It normalizes local
JSON/JSONL harness logs into a report that separates visible traces from
redacted thinking/reasoning blocks.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import pathlib
import re
import sys
from typing import Any


TEXT_TYPES = {"text", "input_text", "output_text", "message"}
THINKING_TYPES = {"thinking", "reasoning", "chain_of_thought"}
TOOL_TYPES = {"toolCall", "tool_call", "tool_use", "function_call"}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


def excerpt(text: str, limit: int) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(0, limit - 3)].rstrip() + "..."


def iter_files(paths: list[str]) -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for raw in paths:
        path = pathlib.Path(raw).expanduser()
        if path.is_dir():
            files.extend(sorted(path.rglob("*.jsonl")))
            files.extend(sorted(path.rglob("*.json")))
        elif path.exists():
            files.append(path)
    return files


def load_json_objects(path: pathlib.Path) -> list[Any]:
    if path.suffix == ".jsonl":
        out = []
        for line_no, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError as exc:
                print(f"warning: {path}:{line_no}: {exc}", file=sys.stderr)
        return out
    try:
        data = json.loads(path.read_text(errors="replace"))
    except json.JSONDecodeError as exc:
        print(f"warning: {path}: {exc}", file=sys.stderr)
        return []
    if isinstance(data, list):
        return data
    return [data]


def block_text(block: Any, include_thinking: bool) -> tuple[str, list[dict[str, Any]], list[str]]:
    thinking: list[dict[str, Any]] = []
    tools: list[str] = []

    if block is None:
        return "", thinking, tools
    if isinstance(block, str):
        return block, thinking, tools
    if isinstance(block, list):
        parts: list[str] = []
        for item in block:
            text, item_thinking, item_tools = block_text(item, include_thinking)
            if text:
                parts.append(text)
            thinking.extend(item_thinking)
            tools.extend(item_tools)
        return "\n".join(parts), thinking, tools
    if not isinstance(block, dict):
        return str(block), thinking, tools

    kind = block.get("type") or block.get("kind") or ""
    name = block.get("name") or block.get("tool_name") or block.get("function", {}).get("name")

    if kind in TOOL_TYPES or "tool" in kind.lower() or name:
        if name:
            tools.append(str(name))

    if kind in THINKING_TYPES or "thinking" in block or "reasoning" in block:
        raw = block.get("text") or block.get("thinking") or block.get("reasoning") or ""
        raw = str(raw)
        thinking.append({"chars": len(raw), "sha256": sha(raw)})
        if include_thinking and raw:
            return f"[recorded-thinking]\n{raw}", thinking, tools
        if raw:
            return f"[recorded-thinking redacted chars={len(raw)} sha256={sha(raw)}]", thinking, tools

    if kind in TEXT_TYPES or "text" in block:
        return str(block.get("text", "")), thinking, tools

    if "content" in block:
        return block_text(block["content"], include_thinking)

    if "arguments" in block:
        return f"[tool-arguments sha256={sha(json.dumps(block['arguments'], sort_keys=True, default=str))}]", thinking, tools

    return "", thinking, tools


def normalize(obj: Any, source: str, include_thinking: bool) -> dict[str, Any] | None:
    if not isinstance(obj, dict):
        return None

    msg = obj.get("message") if isinstance(obj.get("message"), dict) else obj
    role = msg.get("role") or obj.get("role") or obj.get("type")
    if role not in {"user", "assistant", "system", "developer", "tool", "toolResult"}:
        content = msg.get("content") or obj.get("content")
        if content is None:
            return None

    content = msg.get("content", obj.get("content", ""))
    text, thinking, tools = block_text(content, include_thinking)

    if not text and not tools and not thinking:
        return None

    timestamp = obj.get("timestamp") or msg.get("timestamp") or obj.get("created_at")
    usage = msg.get("usage") or obj.get("usage") or {}
    if isinstance(usage, dict) and "cost" in usage and isinstance(usage["cost"], dict):
        usage = {**usage, **{f"cost_{k}": v for k, v in usage["cost"].items()}}

    return {
        "source": source,
        "timestamp": timestamp,
        "role": role or "unknown",
        "text": text,
        "text_sha256": sha(text),
        "chars": len(text),
        "thinking_blocks": thinking,
        "tool_calls": tools,
        "usage": usage,
    }


def signals(text: str) -> list[str]:
    low = text.lower()
    found = []
    patterns = {
        "uncertainty": r"\b(i think|probably|uncertain|not sure|guess|likely|maybe)\b",
        "evidence": r"\b(because|based on|evidence|source|observed|log|trace)\b",
        "constraint": r"\b(can't|cannot|must not|policy|constraint|boundary|allowed|not allowed)\b",
        "tooling": r"\b(tool|command|shell|browser|search|api|function)\b",
        "injection": r"\b(ignore previous|system prompt|developer message|prompt injection|jailbreak)\b",
        "rationale": r"\b(assumption|alternative|reason|decision|tradeoff|uncertainty)\b",
    }
    for name, pattern in patterns.items():
        if re.search(pattern, low):
            found.append(name)
    return found


def build_report(events: list[dict[str, Any]], limit: int) -> dict[str, Any]:
    role_counts = collections.Counter(e["role"] for e in events)
    tool_counts = collections.Counter(t for e in events for t in e["tool_calls"])
    thinking_count = sum(len(e["thinking_blocks"]) for e in events)
    return {
        "summary": {
            "events": len(events),
            "roles": dict(role_counts),
            "tool_calls": dict(tool_counts),
            "thinking_blocks": thinking_count,
        },
        "events": [
            {
                **{k: v for k, v in e.items() if k != "text"},
                "excerpt": excerpt(e["text"], limit),
                "signals": signals(e["text"]),
            }
            for e in events
        ],
    }


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# J-Lens Observability Trace",
        "",
        "This is a harness-log report, not activation-level J-Lens.",
        "",
        "## Summary",
        "",
    ]
    for key, value in report["summary"].items():
        lines.append(f"- {key}: `{value}`")
    lines.extend(["", "## Events", ""])
    for idx, event in enumerate(report["events"], 1):
        lines.append(f"### {idx}. {event['role']}")
        if event.get("timestamp"):
            lines.append(f"- timestamp: `{event['timestamp']}`")
        lines.append(f"- source: `{event['source']}`")
        lines.append(f"- chars: `{event['chars']}`")
        lines.append(f"- text_sha256: `{event['text_sha256']}`")
        if event.get("tool_calls"):
            lines.append(f"- tool_calls: `{event['tool_calls']}`")
        if event.get("thinking_blocks"):
            lines.append(f"- recorded_thinking_blocks: `{event['thinking_blocks']}`")
        if event.get("signals"):
            lines.append(f"- observable_signals: `{event['signals']}`")
        lines.extend(["", event.get("excerpt") or "_No text excerpt._", ""])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="JSON/JSONL files or directories")
    parser.add_argument("--role", choices=["user", "assistant", "system", "developer", "tool", "toolResult"], help="Filter by role")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")
    parser.add_argument("--include-thinking", action="store_true", help="Include recorded thinking/reasoning block text instead of redacting it")
    parser.add_argument("--excerpt-chars", type=int, default=700)
    args = parser.parse_args()

    events: list[dict[str, Any]] = []
    for path in iter_files(args.paths):
        for obj in load_json_objects(path):
            event = normalize(obj, str(path), args.include_thinking)
            if not event:
                continue
            if args.role and event["role"] != args.role:
                continue
            events.append(event)

    report = build_report(events, args.excerpt_chars)
    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
