#!/usr/bin/env python3
import argparse
import json
import re
import sys
from pathlib import Path

from sense_worker import DEFAULT_BASE_URL, DEFAULT_TIMEOUT, request_json


def _read_input(args: argparse.Namespace) -> str:
    if args.input:
        return args.input
    if args.input_file:
        return Path(args.input_file).read_text(encoding="utf-8")
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise SystemExit("input required: pass --input, --input-file, or stdin")


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def build_local_fallback_summary(text: str, max_bullets: int = 2) -> str:
    cleaned = _normalize_whitespace(text)
    if not cleaned:
        return "- 要約対象が空です。"
    parts = re.split(r"(?<=[。！？.!?])\s+", cleaned)
    bullets: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        bullets.append(f"- {part[:120]}")
        if len(bullets) >= max_bullets:
            break
    if not bullets:
        bullets = [f"- {cleaned[:120]}"]
    return "\n".join(bullets)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Minimal ops workflow: offload summarize to Sense worker with local fallback."
    )
    parser.add_argument("--agent", default="ops", help="Owning agent label for logs (default: ops)")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--task", default="summarize")
    parser.add_argument("--input")
    parser.add_argument("--input-file")
    parser.add_argument("--params-json", default="{}")
    parser.add_argument("--no-fallback", action="store_true")
    argv = sys.argv[1:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    args = parser.parse_args(argv)

    text = _read_input(args)
    try:
        params = json.loads(args.params_json)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid --params-json: {exc}")

    payload = {
        "task": args.task,
        "input": text,
        "params": params,
    }
    url = f"{args.base_url.rstrip('/')}/execute"
    print(
        f"[sense-workflow] agent={args.agent} action=execute task={args.task} target={url}",
        file=sys.stderr,
    )
    rc = request_json("POST", url, payload, args.timeout)
    if rc == 0:
        return 0
    if args.no_fallback:
        return rc

    summary = build_local_fallback_summary(text)
    print(
        json.dumps(
            {
                "ok": True,
                "path": "local_fallback",
                "agent": args.agent,
                "task": args.task,
                "summary": summary,
                "error": "sense_worker_unavailable",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
