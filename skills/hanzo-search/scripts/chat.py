#!/usr/bin/env python3
"""RAG chat over search results via the Hanzo Cloud API.

Streams a chat response grounded in documents from a search store.
This endpoint requires the Hanzo Cloud API layer (not native Meilisearch).

Usage:
    python3 chat.py --query "your question" --store "store-name" [options]

Options:
    --query         Chat question (required)
    --store         Search store name (required)
    --mode          Search mode: hybrid, fulltext, vector (default: hybrid)
    --limit         Number of source documents (default: 5)
    --model         LLM model for generation (optional)
    --system-prompt Override system prompt (optional)
    --token         API token (default: $HANZO_API_KEY)
    --base-url      API base URL (default: $HANZO_CHAT_BASE_URL or https://search.hanzo.ai)
    --no-stream     Disable streaming, wait for full response
    --format        Output format: text, json (default: text)
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error


def build_request_body(args: argparse.Namespace) -> dict:
    body: dict = {
        "query": args.query,
        "store": args.store,
        "mode": args.mode,
        "limit": args.limit,
        "stream": not args.no_stream,
    }
    if args.model:
        body["model"] = args.model
    if args.system_prompt:
        body["system_prompt"] = args.system_prompt
    return body


def chat_streaming(args: argparse.Namespace) -> None:
    base_url = (
        args.base_url
        or os.environ.get("HANZO_CHAT_BASE_URL")
        or os.environ.get("HANZO_SEARCH_BASE_URL")
        or "https://search.hanzo.ai"
    ).rstrip("/")
    token = (args.token
             or os.environ.get("HANZO_SEARCH_KEY", "")
             or os.environ.get("HANZO_API_KEY", ""))
    if not token:
        print("Error: No API token. Set HANZO_SEARCH_KEY, HANZO_API_KEY, or use --token.", file=sys.stderr)
        sys.exit(1)

    url = f"{base_url}/api/chat-docs"
    body = build_request_body(args)
    data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "hanzo-bot/1.0",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            if args.no_stream:
                result = json.loads(resp.read().decode("utf-8"))
                if args.format == "json":
                    print(json.dumps(result, indent=2))
                else:
                    print_non_streaming_result(result)
                return

            sources = []
            full_text = []

            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue

                chunk_type = chunk.get("type", "")
                chunk_data = chunk.get("data", {})

                if chunk_type == "source":
                    sources.append(chunk_data)
                    if args.format == "text":
                        title = chunk_data.get("title", "")
                        score = chunk_data.get("score", 0)
                        sys.stderr.write(f"  [source] {title} (score: {score:.3f})\n")
                elif chunk_type == "chunk":
                    text = chunk_data.get("text", "")
                    full_text.append(text)
                    if args.format == "text":
                        sys.stdout.write(text)
                        sys.stdout.flush()
                elif chunk_type == "done":
                    if args.format == "text":
                        sys.stdout.write("\n")
                        sources_count = chunk_data.get("sources_count", len(sources))
                        tokens_used = chunk_data.get("tokens_used", 0)
                        sys.stderr.write(
                            f"\n--- {sources_count} sources | {tokens_used} tokens ---\n"
                        )

            if args.format == "json":
                print(json.dumps({
                    "answer": "".join(full_text),
                    "sources": sources,
                }, indent=2))

    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(f"Error: HTTP {e.code} from Hanzo Chat API", file=sys.stderr)
        if error_body:
            print(error_body[:500], file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Error: Failed to connect to Hanzo Chat API: {e.reason}", file=sys.stderr)
        sys.exit(1)


def print_non_streaming_result(result: dict) -> None:
    answer = result.get("answer", "")
    sources = result.get("sources", [])

    if sources:
        print("Sources:")
        for s in sources:
            title = s.get("title", "Untitled")
            url = s.get("url", "")
            score = s.get("score", 0)
            print(f"  - {title} (score: {score:.3f}){' ' + url if url else ''}")
        print()

    print(answer)


def main() -> None:
    parser = argparse.ArgumentParser(description="RAG chat via Hanzo Cloud API")
    parser.add_argument("--query", required=True, help="Chat question")
    parser.add_argument("--store", required=True, help="Search store name")
    parser.add_argument("--mode", default="hybrid", choices=["hybrid", "fulltext", "vector"],
                        help="Search mode (default: hybrid)")
    parser.add_argument("--limit", type=int, default=5, help="Number of source documents (default: 5)")
    parser.add_argument("--model", default=None, help="LLM model for generation")
    parser.add_argument("--system-prompt", default=None, help="Override system prompt")
    parser.add_argument("--token", default=None, help="API token")
    parser.add_argument("--base-url", default=None, help="API base URL")
    parser.add_argument("--no-stream", action="store_true", help="Disable streaming")
    parser.add_argument("--format", default="text", choices=["text", "json"],
                        help="Output format (default: text)")

    args = parser.parse_args()
    chat_streaming(args)


if __name__ == "__main__":
    main()
