#!/usr/bin/env python3
"""Generate music via Google Lyria API and save as MP3."""
import argparse
import base64
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path


MODELS = {
    "clip": "lyria-3-clip-preview",  # ~30s, MP3
    "pro": "lyria-3-pro-preview",    # ~30s, MP3 or WAV
}
DEFAULT_MODEL = "clip"
BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text[:60] or "music"


def default_out_dir() -> Path:
    now = dt.datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
    preferred = Path.home() / "Projects" / "tmp"
    base = preferred if preferred.is_dir() else Path("./tmp")
    base.mkdir(parents=True, exist_ok=True)
    return base / f"lyria-gen-{now}"


def resolve_api_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    # Try file-based secret (Docker pattern)
    path = os.environ.get("GEMINI_API_KEY_PATH", "").strip()
    if path:
        try:
            key = Path(path).read_text().strip()
            if key:
                return key
        except OSError:
            pass
    sys.exit(
        "Error: GEMINI_API_KEY is not set.\n"
        "Set the environment variable or GEMINI_API_KEY_PATH to the key file."
    )


def generate(prompt: str, model_id: str, api_key: str, output_format: str) -> dict:
    """Call generateContent and return the response dict."""
    url = f"{BASE_URL}/models/{model_id}:generateContent?key={api_key}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
    }
    # Request WAV for pro model if asked
    if output_format == "wav" and "pro" in model_id:
        payload["generationConfig"] = {"responseModalities": ["AUDIO"], "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Aoede"}}}}

    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        sys.exit(f"API error {e.code}: {body}")
    except urllib.error.URLError as e:
        sys.exit(f"Request failed: {e.reason}")


def extract_audio(response: dict) -> tuple[bytes, str, str]:
    """Return (audio_bytes, mime_type, caption)."""
    candidates = response.get("candidates", [])
    if not candidates:
        sys.exit(f"No candidates in response: {json.dumps(response, indent=2)}")

    parts = candidates[0].get("content", {}).get("parts", [])
    audio_data = None
    mime_type = "audio/mpeg"
    caption = ""

    for part in parts:
        if "inlineData" in part:
            inline = part["inlineData"]
            audio_data = base64.b64decode(inline["data"])
            mime_type = inline.get("mimeType", "audio/mpeg")
        elif "text" in part and part["text"].strip():
            caption = part["text"].strip()

    if audio_data is None:
        sys.exit(f"No audio data in response parts: {json.dumps(parts, indent=2)}")

    return audio_data, mime_type, caption


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate music via Google Lyria API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 gen.py "upbeat reggaeton instrumental, 96 BPM"
  python3 gen.py --model pro "ambient piano, melancholic"
  python3 gen.py --out-dir ./music "cinematic orchestral battle theme"
  python3 gen.py --format wav --model pro "jazz trio, live club feel"
""",
    )
    parser.add_argument("prompt", nargs="?", help="Music generation prompt")
    parser.add_argument(
        "--model",
        choices=list(MODELS.keys()),
        default=DEFAULT_MODEL,
        help=f"Lyria model variant (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--format",
        dest="output_format",
        choices=["mp3", "wav"],
        default="mp3",
        help="Output format — WAV only available with --model pro (default: mp3)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Output directory (default: ~/Projects/tmp/lyria-gen-TIMESTAMP/)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print JSON result summary to stdout",
    )

    args = parser.parse_args()

    if not args.prompt:
        parser.print_help()
        sys.exit(1)

    if args.output_format == "wav" and args.model != "pro":
        print("Note: WAV output is only supported with --model pro. Switching to pro.", file=sys.stderr)
        args.model = "pro"

    api_key = resolve_api_key()
    model_id = MODELS[args.model]
    out_dir = args.out_dir or default_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Generating music with {model_id}...", file=sys.stderr)
    print(f"Prompt: {args.prompt}", file=sys.stderr)

    response = generate(args.prompt, model_id, api_key, args.output_format)
    audio_bytes, mime_type, caption = extract_audio(response)

    ext = "wav" if "wav" in mime_type else "mp3"
    filename = f"{slugify(args.prompt)}.{ext}"
    out_path = out_dir / filename
    out_path.write_bytes(audio_bytes)

    print(f"Saved: {out_path}", file=sys.stderr)
    if caption:
        print(f"\nCaption:\n{caption}", file=sys.stderr)

    result = {
        "path": str(out_path),
        "model": model_id,
        "prompt": args.prompt,
        "format": ext,
        "bytes": len(audio_bytes),
        "caption": caption,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(str(out_path))


if __name__ == "__main__":
    main()
