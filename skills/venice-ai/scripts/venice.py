#!/usr/bin/env python3
"""Venice AI CLI — Full platform access: models, chat, embeddings, TTS, transcription."""

import argparse
import base64
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API_BASE = "https://api.venice.ai/api/v1"
USER_AGENT = "ClawdbotVeniceSkill/1.0"
CLAWDBOT_CONFIG = Path.home() / ".clawdbot" / "clawdbot.json"


# ── Auth ─────────────────────────────────────────────────────────────────────

def get_api_key() -> str | None:
    """Get API key from env or clawdbot config."""
    key = os.environ.get("VENICE_API_KEY", "").strip()
    if key:
        return key
    if CLAWDBOT_CONFIG.exists():
        try:
            cfg = json.loads(CLAWDBOT_CONFIG.read_text())
            for skill_name in ("venice-ai", "venice-ai-media"):
                k = (cfg.get("skills", {}).get("entries", {})
                     .get(skill_name, {}).get("env", {})
                     .get("VENICE_API_KEY", ""))
                if k:
                    return k.strip()
        except (json.JSONDecodeError, OSError):
            pass
    return None


def require_key() -> str:
    key = get_api_key()
    if not key:
        print("Error: VENICE_API_KEY not found.", file=sys.stderr)
        print("Set env var or configure in ~/.clawdbot/clawdbot.json", file=sys.stderr)
        print("Get your key: https://venice.ai/settings/api", file=sys.stderr)
        sys.exit(2)
    return key


# ── HTTP ─────────────────────────────────────────────────────────────────────

def api_request(endpoint: str, method: str = "GET", payload: dict | None = None,
                api_key: str | None = None, timeout: int = 120,
                stream: bool = False, raw_data: bytes | None = None,
                content_type: str | None = None) -> dict | bytes | None:
    """Make request to Venice API. Returns parsed JSON or raw bytes."""
    url = f"{API_BASE}/{endpoint.lstrip('/')}"
    headers = {"User-Agent": USER_AGENT}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    data = None
    if payload:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    elif raw_data:
        if content_type:
            headers["Content-Type"] = content_type
        data = raw_data

    req = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        if stream:
            return _stream_response(resp)
        body = resp.read()
        ct = resp.headers.get("Content-Type", "")

        # Extract useful headers
        extra = {}
        for h in ("x-venice-balance-usd", "x-venice-balance-diem", "x-venice-balance-vcu",
                   "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens"):
            v = resp.headers.get(h)
            if v:
                extra[h] = v

        if "application/json" in ct:
            result = json.loads(body)
            if extra:
                result["_venice_headers"] = extra
            return result
        return body
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        print(f"Error ({e.code}): {err}", file=sys.stderr)
        sys.exit(1)


def _stream_response(resp):
    """Stream SSE response, printing tokens as they arrive."""
    usage = None
    for line in resp:
        line = line.decode("utf-8", errors="replace").strip()
        if not line or not line.startswith("data: "):
            continue
        data = line[6:]
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
            choices = chunk.get("choices", [])
            if choices:
                delta = choices[0].get("delta", {})
                content = delta.get("content", "")
                if content:
                    print(content, end="", flush=True)
            if chunk.get("usage"):
                usage = chunk["usage"]
        except json.JSONDecodeError:
            pass
    print()  # final newline
    return usage


def multipart_upload(endpoint: str, fields: dict, files: dict,
                     api_key: str, timeout: int = 120) -> dict:
    """Multipart form upload for audio endpoints."""
    import io
    boundary = "----VeniceBoundary" + dt.datetime.now().strftime("%Y%m%d%H%M%S%f")
    body = io.BytesIO()

    for k, v in fields.items():
        body.write(f"--{boundary}\r\n".encode())
        body.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        body.write(f"{v}\r\n".encode())

    for k, (filename, filedata, mime) in files.items():
        body.write(f"--{boundary}\r\n".encode())
        body.write(f'Content-Disposition: form-data; name="{k}"; filename="{filename}"\r\n'.encode())
        body.write(f"Content-Type: {mime}\r\n\r\n".encode())
        body.write(filedata)
        body.write(b"\r\n")

    body.write(f"--{boundary}--\r\n".encode())
    raw = body.getvalue()

    url = f"{API_BASE}/{endpoint.lstrip('/')}"
    headers = {
        "User-Agent": USER_AGENT,
        "Authorization": f"Bearer {api_key}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    }
    req = urllib.request.Request(url, method="POST", headers=headers, data=raw)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        ct = resp.headers.get("Content-Type", "")
        body = resp.read()
        if "application/json" in ct:
            return json.loads(body)
        return {"_raw": body, "_content_type": ct}
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        print(f"Error ({e.code}): {err}", file=sys.stderr)
        sys.exit(1)


# ── Commands ─────────────────────────────────────────────────────────────────

def cmd_models(args):
    """List and filter Venice models."""
    key = require_key()
    types = [t.strip() for t in args.type.split(",")]
    all_models = []
    for t in types:
        data = api_request(f"/models?type={t}", api_key=key, timeout=30)
        models = data.get("data", []) if isinstance(data, dict) else []
        all_models.extend(models)

    if args.filter:
        filt = args.filter.lower()
        all_models = [m for m in all_models if filt in m.get("id", "").lower()
                      or filt in m.get("model_spec", {}).get("description", "").lower()]

    if not all_models:
        print("No models found.")
        return

    print(f"\n{'Model ID':<45} {'Type':<10} {'Status':<12} {'Privacy':<12} {'Info'}")
    print("-" * 120)
    for m in sorted(all_models, key=lambda x: x.get("id", "")):
        mid = m.get("id", "unknown")
        mtype = m.get("type", "?")
        spec = m.get("model_spec", {})

        if spec.get("offline"):
            status = "offline"
        elif spec.get("beta"):
            status = "beta"
        elif spec.get("deprecation", {}).get("date"):
            status = "deprecated"
        else:
            status = "available"

        # Privacy
        privacy = "private" if spec.get("availableForPrivateInference") else "anonymized"

        # Info
        desc = spec.get("description", "")[:40]
        ctx = spec.get("constraints", {}).get("max_context_length")
        ctx_str = f"ctx:{ctx//1000}K" if ctx else ""

        info_parts = [p for p in [desc, ctx_str] if p]
        info = " | ".join(info_parts)

        print(f"{mid:<45} {mtype:<10} {status:<12} {privacy:<12} {info[:50]}")

    print(f"\nTotal: {len(all_models)} models")


def cmd_chat(args):
    """Generate text via chat completions."""
    key = require_key()

    # Build messages
    messages = []
    if args.system:
        messages.append({"role": "system", "content": args.system})

    # Get user content from args or stdin
    if args.prompt:
        user_content = " ".join(args.prompt)
    elif not sys.stdin.isatty():
        user_content = sys.stdin.read().strip()
    else:
        print("Error: provide a prompt or pipe content via stdin", file=sys.stderr)
        sys.exit(1)

    messages.append({"role": "user", "content": user_content})

    # Build payload
    model = args.model or "deepseek-v3.2"
    payload = {
        "model": model,
        "messages": messages,
    }

    if args.stream:
        payload["stream"] = True
    if args.temperature is not None:
        payload["temperature"] = args.temperature
    if args.max_tokens:
        payload["max_tokens"] = args.max_tokens
    if args.json:
        payload["response_format"] = {"type": "json_object"}
    if args.reasoning_effort:
        payload["reasoning_effort"] = args.reasoning_effort

    # Venice-specific parameters
    venice_params = {}
    if args.web_search and args.web_search != "off":
        venice_params["enable_web_search"] = args.web_search
    if args.web_citations:
        venice_params["enable_web_citations"] = True
    if args.web_scrape:
        venice_params["enable_web_scraping"] = True
    if args.no_venice_system_prompt:
        venice_params["include_venice_system_prompt"] = False
    if args.strip_thinking:
        venice_params["strip_thinking_response"] = True
    if args.disable_thinking:
        venice_params["disable_thinking"] = True
        venice_params["strip_thinking_response"] = True
    if args.character:
        venice_params["character_slug"] = args.character

    if venice_params:
        payload["venice_parameters"] = venice_params

    if args.cache_key:
        payload["prompt_cache_key"] = args.cache_key

    # Make request
    if args.stream:
        usage = api_request("/chat/completions", method="POST", payload=payload,
                            api_key=key, stream=True, timeout=args.timeout or 120)
        if args.show_usage and usage:
            _print_usage(usage)
    else:
        resp = api_request("/chat/completions", method="POST", payload=payload,
                           api_key=key, timeout=args.timeout or 120)
        if not resp or not isinstance(resp, dict):
            print("Error: empty response", file=sys.stderr)
            sys.exit(1)

        choices = resp.get("choices", [])
        if choices:
            msg = choices[0].get("message", {})
            content = msg.get("content", "")
            reasoning = msg.get("reasoning_content", "")
            if reasoning and not args.strip_thinking and not args.disable_thinking:
                print(f"<thinking>\n{reasoning}\n</thinking>\n")
            # Client-side strip of <think> tags if requested or thinking disabled
            if (args.strip_thinking or args.disable_thinking) and content:
                import re
                content = re.sub(r"<think>.*?</think>\s*", "", content, flags=re.DOTALL).strip()
            print(content)

        if args.show_usage:
            _print_usage(resp.get("usage", {}))
            headers = resp.get("_venice_headers", {})
            if headers:
                print("\n--- Balance ---", file=sys.stderr)
                for k, v in headers.items():
                    print(f"  {k}: {v}", file=sys.stderr)


def _print_usage(usage: dict):
    """Print token usage stats."""
    if not usage:
        return
    print("\n--- Usage ---", file=sys.stderr)
    print(f"  Prompt tokens:     {usage.get('prompt_tokens', '?')}", file=sys.stderr)
    print(f"  Completion tokens: {usage.get('completion_tokens', '?')}", file=sys.stderr)
    print(f"  Total tokens:      {usage.get('total_tokens', '?')}", file=sys.stderr)
    details = usage.get("prompt_tokens_details", {})
    if details.get("cached_tokens"):
        print(f"  Cached tokens:     {details['cached_tokens']}", file=sys.stderr)


def cmd_embed(args):
    """Generate embeddings."""
    key = require_key()

    texts = list(args.texts) if args.texts else []
    if args.file:
        with open(args.file) as f:
            texts.extend(line.strip() for line in f if line.strip())

    if not texts:
        if not sys.stdin.isatty():
            texts = [line.strip() for line in sys.stdin if line.strip()]
        else:
            print("Error: provide texts as arguments, --file, or via stdin", file=sys.stderr)
            sys.exit(1)

    payload = {
        "model": "text-embedding-bge-m3",
        "input": texts if len(texts) > 1 else texts[0],
    }

    resp = api_request("/embeddings", method="POST", payload=payload, api_key=key)

    if args.output == "json":
        print(json.dumps(resp, indent=2))
    else:
        data = resp.get("data", [])
        for item in data:
            idx = item.get("index", 0)
            emb = item.get("embedding", [])
            print(f"[{idx}] dimension={len(emb)}, first_5={emb[:5]}")
        usage = resp.get("usage", {})
        if usage:
            print(f"\nTokens used: {usage.get('total_tokens', '?')}", file=sys.stderr)


def cmd_tts(args):
    """Text-to-speech generation."""
    key = require_key()

    if args.list_voices:
        _print_tts_voices()
        return

    if not args.text:
        print("Error: provide text to speak", file=sys.stderr)
        sys.exit(1)

    text = " ".join(args.text)
    payload = {
        "model": "tts-kokoro",
        "input": text,
        "voice": args.voice or "af_sky",
    }
    if args.speed:
        payload["speed"] = args.speed

    # TTS returns audio bytes
    resp = api_request("/audio/speech", method="POST", payload=payload,
                       api_key=key, timeout=60)

    if isinstance(resp, bytes):
        out = Path(args.output) if args.output else Path(f"/tmp/venice-tts-{int(dt.datetime.now().timestamp())}.mp3")
        out.write_bytes(resp)
        print(f"Audio saved to: {out}")
        print(f"\nMEDIA: {out.as_posix()}")
    elif isinstance(resp, dict) and "_raw" in resp:
        out = Path(args.output) if args.output else Path(f"/tmp/venice-tts-{int(dt.datetime.now().timestamp())}.mp3")
        out.write_bytes(resp["_raw"])
        print(f"Audio saved to: {out}")
        print(f"\nMEDIA: {out.as_posix()}")
    else:
        print("Unexpected response format", file=sys.stderr)
        print(str(resp)[:500], file=sys.stderr)


def _print_tts_voices():
    """Print available TTS voices."""
    voices = {
        "English (US/UK)": ["af_sky", "af_nova", "af_bella", "af_heart", "af_nicole", "af_sarah",
                            "am_adam", "am_liam", "am_michael", "am_eric",
                            "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_george", "bm_lewis"],
        "Chinese": ["zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zm_yunjian", "zm_yunxi"],
        "Japanese": ["jf_alpha", "jf_gongitsune", "jm_kumo"],
        "French": ["ff_siwis"],
        "Hindi": ["hf_alpha", "hm_omega"],
        "Italian": ["if_sara", "im_nicola"],
        "Portuguese (BR)": ["pf_dora", "pm_alex"],
        "Spanish": ["ef_dora", "em_alex"],
    }
    print("\nAvailable TTS Voices (tts-kokoro):\n")
    for lang, vs in voices.items():
        print(f"  {lang}:")
        for v in vs:
            print(f"    {v}")
    print("\nPrefix key: a=American, b=British, z=Chinese, j=Japanese, f=female, m=male")


def cmd_transcribe(args):
    """Speech-to-text transcription."""
    key = require_key()

    if args.url:
        # Download audio from URL
        req = urllib.request.Request(args.url, headers={"User-Agent": USER_AGENT})
        resp = urllib.request.urlopen(req, timeout=60)
        audio_data = resp.read()
        filename = args.url.split("/")[-1].split("?")[0] or "audio.wav"
        mime = resp.headers.get("Content-Type", "audio/wav")
    elif args.file:
        fp = Path(args.file)
        if not fp.exists():
            print(f"Error: file not found: {fp}", file=sys.stderr)
            sys.exit(1)
        audio_data = fp.read_bytes()
        filename = fp.name
        suffix = fp.suffix.lower()
        mime_map = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac",
                    ".m4a": "audio/mp4", ".aac": "audio/aac", ".mp4": "video/mp4"}
        mime = mime_map.get(suffix, "application/octet-stream")
    else:
        print("Error: provide --file or --url", file=sys.stderr)
        sys.exit(1)

    fields = {"model": "nvidia/parakeet-tdt-0.6b-v3"}
    if args.timestamps:
        fields["timestamps"] = "true"

    files = {"file": (filename, audio_data, mime)}
    resp = multipart_upload("/audio/transcriptions", fields, files, key, timeout=120)

    if isinstance(resp, dict):
        text = resp.get("text", "")
        if text:
            print(text)
        else:
            print(json.dumps(resp, indent=2))
    else:
        print(resp)


def cmd_balance(args):
    """Check account balance via a minimal inference call."""
    key = require_key()
    # Use a tiny, cheap inference call to get balance headers
    payload = {
        "model": "qwen3-4b",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
        "venice_parameters": {"disable_thinking": True},
    }
    resp = api_request("/chat/completions", method="POST", payload=payload, api_key=key, timeout=15)
    headers = resp.get("_venice_headers", {}) if isinstance(resp, dict) else {}
    balance_keys = {k: v for k, v in headers.items() if "balance" in k}
    rate_keys = {k: v for k, v in headers.items() if "ratelimit" in k}
    if balance_keys or rate_keys:
        print("Venice Account Balance:")
        for k, v in balance_keys.items():
            label = k.replace("x-venice-balance-", "").upper()
            print(f"  {label}: {v}")
        if rate_keys:
            print("\nRate Limits:")
            for k, v in rate_keys.items():
                label = k.replace("x-ratelimit-remaining-", "Remaining ").replace("-", " ")
                print(f"  {label}: {v}")
    else:
        print("Balance info not available.")
        print("Check your balance at: https://venice.ai/settings/api")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Venice AI CLI", prog="venice")
    sub = parser.add_subparsers(dest="command", help="Command")

    # models
    p_models = sub.add_parser("models", help="Browse model catalog")
    p_models.add_argument("--type", default="text", help="Model type(s), comma-separated: text,image,video,audio,embedding")
    p_models.add_argument("--filter", help="Filter models by keyword")

    # chat
    p_chat = sub.add_parser("chat", help="Text generation (chat completions)")
    p_chat.add_argument("prompt", nargs="*", help="Prompt text")
    p_chat.add_argument("--model", "-m", help="Model ID (default: deepseek-v3.2)")
    p_chat.add_argument("--system", "-s", help="System prompt")
    p_chat.add_argument("--stream", action="store_true", help="Stream output")
    p_chat.add_argument("--temperature", "-t", type=float, help="Sampling temperature")
    p_chat.add_argument("--max-tokens", type=int, help="Max output tokens")
    p_chat.add_argument("--json", action="store_true", help="Request JSON output")
    p_chat.add_argument("--web-search", choices=["off", "on", "auto"], help="Enable web search")
    p_chat.add_argument("--web-citations", action="store_true", help="Include web citations")
    p_chat.add_argument("--web-scrape", action="store_true", help="Enable URL scraping")
    p_chat.add_argument("--no-venice-system-prompt", action="store_true", help="Disable Venice system prompts")
    p_chat.add_argument("--character", help="Venice character slug")
    p_chat.add_argument("--reasoning-effort", choices=["low", "medium", "high"], help="Reasoning effort level")
    p_chat.add_argument("--strip-thinking", action="store_true", help="Strip thinking blocks from output")
    p_chat.add_argument("--disable-thinking", action="store_true", help="Disable reasoning entirely")
    p_chat.add_argument("--cache-key", help="Prompt cache routing key")
    p_chat.add_argument("--show-usage", action="store_true", help="Show token usage stats")
    p_chat.add_argument("--timeout", type=int, help="Request timeout in seconds")

    # embed
    p_embed = sub.add_parser("embed", help="Generate embeddings")
    p_embed.add_argument("texts", nargs="*", help="Texts to embed")
    p_embed.add_argument("--file", help="File with texts (one per line)")
    p_embed.add_argument("--output", choices=["summary", "json"], default="summary", help="Output format")

    # tts
    p_tts = sub.add_parser("tts", help="Text-to-speech")
    p_tts.add_argument("text", nargs="*", help="Text to speak")
    p_tts.add_argument("--voice", help="Voice ID (default: af_sky)")
    p_tts.add_argument("--speed", type=float, help="Speed multiplier")
    p_tts.add_argument("--output", "-o", help="Output file path")
    p_tts.add_argument("--list-voices", action="store_true", help="List available voices")

    # transcribe
    p_trans = sub.add_parser("transcribe", help="Speech-to-text")
    p_trans.add_argument("file", nargs="?", help="Audio file path")
    p_trans.add_argument("--url", help="Audio URL")
    p_trans.add_argument("--timestamps", action="store_true", help="Include word timestamps")

    # balance
    sub.add_parser("balance", help="Check account balance")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    cmds = {
        "models": cmd_models,
        "chat": cmd_chat,
        "embed": cmd_embed,
        "tts": cmd_tts,
        "transcribe": cmd_transcribe,
        "balance": cmd_balance,
    }
    cmds[args.command](args)


if __name__ == "__main__":
    main()
