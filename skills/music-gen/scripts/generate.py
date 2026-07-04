#!/usr/bin/env python3
"""music-gen — generate a music/audio clip via OpenRouter (Google Lyria) → mp3.

Usage:   generate.py "<prompt>" [outfile.mp3]
Env:     OPENROUTER_API_KEY (required); MUSIC_MODEL (default google/lyria-3-pro-preview)

Stdlib only (no jq/curl) — the gateway containers have python3 but not jq.
Verified 2026-07-05: audio output REQUIRES stream:true + an `audio` config;
base64 chunks arrive at choices[0].delta.audio.data (no final message.audio).
Lyria is billed ~$0.08/song — NOT free despite $0 token prices.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

API_URL = "https://openrouter.ai/api/v1/chat/completions"


def main() -> None:
    prompt = sys.argv[1] if len(sys.argv) > 1 else ""
    out = sys.argv[2] if len(sys.argv) > 2 else f"music-{int(time.time())}.mp3"
    key = os.environ.get("OPENROUTER_API_KEY")
    model = os.environ.get("MUSIC_MODEL", "google/lyria-3-pro-preview")

    if not key:
        sys.exit("music-gen: OPENROUTER_API_KEY is not set")
    if not prompt:
        print('usage: generate.py "<prompt>" [outfile.mp3]', file=sys.stderr)
        sys.exit(2)

    body = json.dumps({
        "model": model,
        "stream": True,
        "modalities": ["text", "audio"],
        "audio": {"format": "mp3"},
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        API_URL, data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )

    chunks = []
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            for raw in resp:  # SSE lines, streamed as they arrive
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue  # skip ": OPENROUTER PROCESSING" keep-alives
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if obj.get("error"):
                    sys.exit(f"music-gen: API error: {obj['error'].get('message', '')}")
                delta = (obj.get("choices") or [{}])[0].get("delta") or {}
                audio = delta.get("audio") or {}
                if audio.get("data"):
                    chunks.append(audio["data"])
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read().decode()).get("error", {}).get("message", "")
        except Exception:
            pass
        if e.code == 402 and not detail:
            detail = "Out of OpenRouter credit — top up to continue."
        sys.exit(f"music-gen: API error ({e.code}): {detail or 'request failed'}")
    except urllib.error.URLError as e:
        sys.exit(f"music-gen: network error: {e.reason}")

    if not chunks:
        sys.exit("music-gen: no audio returned for this prompt")
    audio_bytes = base64.b64decode("".join(chunks))
    if len(audio_bytes) < 10000:
        sys.exit(f"music-gen: audio too small ({len(audio_bytes)}B), likely failed")
    with open(out, "wb") as f:
        f.write(audio_bytes)
    print(out)


if __name__ == "__main__":
    main()
