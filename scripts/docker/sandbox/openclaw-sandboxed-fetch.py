#!/usr/bin/env python3
"""Fetches a URL and extracts clean text, run inside the OpenClaw sandbox
container so untrusted response bytes are processed away from the gateway's
own process. Stdlib only -- the sandbox image has no package manager access
at runtime. Emits exactly one JSON object on stdout; never raises to the
caller (all failures become {"ok": false, "error": "..."}).
"""
import json
import subprocess
import sys
from html.parser import HTMLParser

FETCH_TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 2_000_000  # independent cap; do not trust the caller's maxChars alone
STRIP_TAGS = {"script", "style", "nav", "header", "footer", "noscript"}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in STRIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in STRIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._chunks.append(data)

    def get_text(self) -> str:
        return " ".join(" ".join(self._chunks).split())


def extract_clean_text(html: str, max_chars: int) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    text = parser.get_text()
    if len(text) > max_chars:
        text = text[:max_chars] + "... [truncated]"
    return text


def fetch(url: str, pinned_ip: str | None) -> str:
    args = [
        "curl",
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        str(FETCH_TIMEOUT_SECONDS),
        "--max-filesize",
        str(MAX_RESPONSE_BYTES),
        "-A",
        "OpenClawSandboxedFetch/0.1",
    ]
    if pinned_ip:
        # Pin the connection to the host's already-validated IP without a
        # second, potentially-rebindable DNS lookup inside the container,
        # while keeping the Host header/TLS SNI correct for the real hostname.
        from urllib.parse import urlparse

        parsed = urlparse(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        args += ["--resolve", f"{parsed.hostname}:{port}:{pinned_ip}"]
    args.append(url)
    result = subprocess.run(args, capture_output=True, timeout=FETCH_TIMEOUT_SECONDS + 5)
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"curl failed (exit {result.returncode}): {stderr or 'no stderr'}")
    return result.stdout.decode("utf-8", errors="replace")


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: script.py <url> <max-chars> [<pinned-ip>]"}))
        return
    url = sys.argv[1]
    try:
        max_chars = int(sys.argv[2])
    except ValueError:
        print(json.dumps({"ok": False, "error": f"invalid max-chars: {sys.argv[2]}"}))
        return
    pinned_ip = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None

    try:
        html = fetch(url, pinned_ip)
        text = extract_clean_text(html, max_chars)
        print(json.dumps({"ok": True, "text": text}))
    except subprocess.TimeoutExpired:
        print(json.dumps({"ok": False, "error": "fetch timed out"}))
    except Exception as exc:  # noqa: BLE001 -- must never raise past this boundary
        print(json.dumps({"ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
