#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.31.0,<3",
# ]
# ///
"""
Generate royalty-free AI music using the Loudly Music API.

Parametric generation:
    uv run generate_music.py --genre "House" --duration 30 --energy high --filename "output.mp3"

With a text prompt (genre is still required):
    uv run generate_music.py --genre "Lo Fi" --prompt "chill study beats" --duration 60 --filename "output.mp3"
"""

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

API_BASE = "https://soundtracks.loudly.com/api"
ALLOWED_DOWNLOAD_HOSTS = (".cloudfront.net", ".loudly.com")
MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024  # 100 MB


def get_api_key() -> str | None:
    return os.environ.get("LOUDLY_API_KEY")


def build_headers(api_key: str) -> dict:
    return {
        "API-KEY": api_key,
        "Accept": "application/json",
    }


def validate_output_path(filename: str) -> Path:
    """Resolve the output path and block writes to sensitive locations."""
    output_path = Path(filename).resolve()
    path_str = str(output_path)
    home = Path.home().resolve()

    # Block sensitive system directories
    for prefix in ("/etc", "/usr", "/var", "/sys", "/proc", "/dev", "/boot", "/sbin"):
        if path_str.startswith(prefix + "/") or path_str == prefix:
            print(f"Error: cannot write to system directory ({prefix}).", file=sys.stderr)
            sys.exit(1)

    # Block sensitive dotdirs in home
    for dotdir in (".ssh", ".gnupg", ".openclaw", ".config"):
        sensitive = str(home / dotdir)
        if path_str.startswith(sensitive + "/") or path_str == sensitive:
            print(f"Error: cannot write to {dotdir}/.", file=sys.stderr)
            sys.exit(1)

    return output_path


def validate_download_url(url: str) -> None:
    """Validate that the download URL points to an expected host over HTTPS."""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        print(f"Error: download URL must use HTTPS, got '{parsed.scheme}'.", file=sys.stderr)
        sys.exit(1)
    if not parsed.hostname or not any(parsed.hostname.endswith(h) for h in ALLOWED_DOWNLOAD_HOSTS):
        print(f"Error: download URL host '{parsed.hostname}' is not in the allowlist.", file=sys.stderr)
        sys.exit(1)


def generate_music(api_key: str, params: dict) -> dict:
    """Generate music via POST /ai/songs. The API is synchronous."""
    import requests

    headers = build_headers(api_key)

    form_data = {}
    for key, value in params.items():
        if value is not None:
            form_data[key] = (None, str(value))

    response = requests.post(
        f"{API_BASE}/ai/songs",
        headers=headers,
        files=form_data,
        timeout=(10, 120),
    )

    if response.status_code != 200:
        print(f"Error: API returned status {response.status_code}.", file=sys.stderr)
        sys.exit(1)

    try:
        return response.json()
    except ValueError:
        print("Error: API returned non-JSON response.", file=sys.stderr)
        sys.exit(1)


def download_audio(url: str, output_path: Path) -> None:
    import requests

    validate_download_url(url)

    print("Downloading audio...")
    response = requests.get(url, stream=True, timeout=(10, 300))

    if response.status_code != 200:
        print(f"Error: Download failed with status {response.status_code}.", file=sys.stderr)
        sys.exit(1)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        with open(output_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=8192):
                written += len(chunk)
                if written > MAX_DOWNLOAD_BYTES:
                    raise RuntimeError("download exceeded 100 MB limit")
                f.write(chunk)
    except (RuntimeError, OSError) as exc:
        output_path.unlink(missing_ok=True)
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Generate royalty-free AI music using the Loudly Music API"
    )
    parser.add_argument(
        "--genre", "-g",
        required=True,
        help="Genre name (required). E.g. House, Ambient, Lo Fi, Hip Hop, EDM"
    )
    parser.add_argument(
        "--prompt", "-p",
        help="Text description to guide the generation (used alongside genre)"
    )
    parser.add_argument(
        "--genre-blend",
        help="Secondary genre to blend with the primary genre"
    )
    parser.add_argument(
        "--duration", "-d",
        type=int,
        default=30,
        help="Duration in seconds (default: 30)"
    )
    parser.add_argument(
        "--energy", "-e",
        choices=["low", "high", "original"],
        help="Energy level: low, high, or original"
    )
    parser.add_argument(
        "--bpm", "-b",
        type=int,
        help="Tempo in beats per minute"
    )
    parser.add_argument(
        "--key-root",
        help="Musical key root (e.g. C, D, F#)"
    )
    parser.add_argument(
        "--key-quality",
        choices=["major", "minor"],
        help="Key quality: major or minor"
    )
    parser.add_argument(
        "--instruments",
        help="Comma-separated list of instruments"
    )
    parser.add_argument(
        "--structure-id",
        help="Structure template ID"
    )
    parser.add_argument(
        "--filename", "-f",
        required=True,
        help="Output filename (e.g. house-track.mp3)"
    )

    args = parser.parse_args()

    api_key = get_api_key()
    if not api_key:
        print("Error: LOUDLY_API_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    output_path = validate_output_path(args.filename)

    # Build parameters
    params = {"genre": args.genre, "duration": args.duration}
    if args.prompt:
        params["prompt"] = args.prompt
    if args.genre_blend:
        params["genre_blend"] = args.genre_blend
    if args.energy:
        params["energy"] = args.energy
    if args.bpm is not None:
        params["bpm"] = args.bpm
    if args.key_root:
        params["key_root"] = args.key_root
    if args.key_quality:
        params["key_quality"] = args.key_quality
    if args.instruments:
        params["instruments"] = args.instruments
    if args.structure_id:
        params["structure_id"] = args.structure_id

    print(f"Generating {args.genre} music...")
    if args.prompt:
        print(f"Prompt: \"{args.prompt}\"")
    print(f"Duration: {args.duration}s | Energy: {args.energy or 'default'} | BPM: {args.bpm or 'default'}")

    data = generate_music(api_key, params)

    # The API returns the audio URL in music_file_path
    audio_url = data.get("music_file_path")
    if not audio_url:
        print("Error: No music_file_path in API response.", file=sys.stderr)
        sys.exit(1)

    title = data.get("title", "Untitled")
    duration_ms = data.get("duration", 0)
    bpm = data.get("bpm", "?")
    key_info = data.get("key", {})
    key_name = key_info.get("name", "?") if isinstance(key_info, dict) else "?"

    print(f"Generated: \"{title}\" | {duration_ms / 1000:.0f}s | {bpm} BPM | Key: {key_name}")

    # Download
    download_audio(audio_url, output_path)

    size_kb = output_path.stat().st_size / 1024
    print(f"\nMusic saved: {output_path} ({size_kb:.1f} KB)")
    # OpenClaw parses MEDIA tokens and will attach the file on supported providers.
    print(f"MEDIA: {output_path}")


if __name__ == "__main__":
    main()
