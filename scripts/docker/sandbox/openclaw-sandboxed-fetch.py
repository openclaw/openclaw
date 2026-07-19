#!/usr/bin/env python3
"""Fetches a URL and extracts clean text, run inside the OpenClaw sandbox
container so untrusted response bytes are processed away from the gateway's
own process. Stdlib only -- the sandbox image has no package manager access
at runtime. Emits exactly one JSON object on stdout; never raises to the
caller (all failures become {"ok": false, "error": "..."}).
"""
import json
import os
import select
import subprocess
import sys
import time
from html.parser import HTMLParser

FETCH_TIMEOUT_SECONDS = 15
# Backstop only: curl's own --max-time already enforces FETCH_TIMEOUT_SECONDS.
# This bounds how long we block in the read loop below if curl ever hangs
# without honoring --max-time or without closing its stdout pipe.
FETCH_HARD_TIMEOUT_SECONDS = FETCH_TIMEOUT_SECONDS + 5
# Enforced by the streaming read loop in fetch() below, not by curl's
# --max-filesize: that flag only aborts a transfer that has a known
# Content-Length up front. For chunked-encoded responses (no Content-Length
# header -- the ordinary shape of dynamic/streamed HTTP/1.1 content) curl
# 7.88.1 (and other tested versions) silently ignores --max-filesize and
# lets the full body through. Reading the body ourselves in bounded chunks
# and aborting once the running total exceeds this cap is correct
# regardless of whether the response declares its length.
MAX_RESPONSE_BYTES = 2_000_000
READ_CHUNK_BYTES = 65536
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

    # Popen (not subprocess.run/capture_output) so the body is streamed to us
    # chunk by chunk: we enforce MAX_RESPONSE_BYTES ourselves below instead of
    # trusting curl's --max-filesize, which is a no-op for chunked responses.
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    body = bytearray()
    deadline = time.monotonic() + FETCH_HARD_TIMEOUT_SECONDS
    error: Exception | None = None
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                error = TimeoutError("fetch timed out")
                break
            ready, _, _ = select.select([proc.stdout], [], [], remaining)
            if not ready:
                error = TimeoutError("fetch timed out")
                break
            chunk = os.read(proc.stdout.fileno(), READ_CHUNK_BYTES)
            if not chunk:
                break  # curl closed stdout: transfer finished (success or curl-level error)
            body += chunk
            if len(body) > MAX_RESPONSE_BYTES:
                error = ValueError("response exceeded size limit")
                break
    finally:
        # Always tear the child down and drain stderr, whether we broke out
        # normally, on our own size/time limit, or via an unexpected error.
        if proc.poll() is None:
            proc.kill()
        proc.stdout.close()
        stderr_bytes = proc.stderr.read()
        proc.stderr.close()
        proc.wait()

    if error is not None:
        raise error
    if proc.returncode != 0:
        stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"curl failed (exit {proc.returncode}): {stderr_text or 'no stderr'}")
    return bytes(body).decode("utf-8", errors="replace")


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
    except Exception as exc:  # noqa: BLE001 -- must never raise past this boundary
        print(json.dumps({"ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
