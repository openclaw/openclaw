#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from pathlib import Path

from sense_worker import DEFAULT_BASE_URL, DEFAULT_TIMEOUT, request_json_result


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


def build_local_fallback_draft(text: str) -> str:
    cleaned = _normalize_whitespace(text)
    if not cleaned:
        return "ご連絡ありがとうございます。内容を確認し、折り返しご案内いたします。"
    excerpt = cleaned[:120]
    return (
        "ご連絡ありがとうございます。\n"
        f"以下の内容で一次整理しました: {excerpt}\n"
        "担当に引き継いで、折り返しご連絡いたします。"
    )


def build_local_fallback_analysis(text: str) -> dict:
    cleaned = _normalize_whitespace(text)
    if not cleaned:
        return {
            "summary": "解析対象が空です。",
            "key_points": [],
            "suggested_next_action": "入力内容を確認して再実行してください。",
        }
    parts = re.split(r"(?<=[。！？.!?])\s+", cleaned)
    points = [part.strip()[:100] for part in parts if part.strip()][:3]
    if not points:
        points = [cleaned[:100]]
    return {
        "summary": cleaned[:140],
        "key_points": points,
        "suggested_next_action": "主要論点を確認し、次の担当へ引き継いでください。",
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Minimal ops workflow: offload summarize to Sense worker with local fallback."
    )
    parser.add_argument("--agent", default="ops", help="Owning agent label for logs (default: ops)")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--task", default="summarize")
    parser.add_argument("--token")
    parser.add_argument("--token-env", default="SENSE_WORKER_TOKEN")
    parser.add_argument("--input")
    parser.add_argument("--input-file")
    parser.add_argument("--params-json", default="{}")
    parser.add_argument("--no-fallback", action="store_true")
    argv = sys.argv[1:]
    argv = [arg for arg in argv if arg != "--"]
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
    token = args.token or os.environ.get(args.token_env)
    print(
        f"[sense-workflow] agent={args.agent} action=execute task={args.task} target={url}",
        file=sys.stderr,
    )
    result = request_json_result("POST", url, payload, args.timeout, token=token)
    stream = sys.stdout if result.get("ok") else sys.stderr
    print(json.dumps(result, ensure_ascii=False, indent=2), file=stream)
    if result.get("ok"):
        return 0
    status = result.get("status")
    if status == 401:
        return 1
    if args.no_fallback:
        return 1

    if args.task == "generate_draft":
        fallback_key = "draft"
        fallback_value = build_local_fallback_draft(text)
    elif args.task == "analyze_text":
        fallback_key = "analysis"
        fallback_value = build_local_fallback_analysis(text)
    else:
        fallback_key = "summary"
        fallback_value = build_local_fallback_summary(text)
    print(
        json.dumps(
            {
                "ok": True,
                "path": "local_fallback",
                "agent": args.agent,
                "task": args.task,
                fallback_key: fallback_value,
                "error": "sense_worker_unavailable",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
