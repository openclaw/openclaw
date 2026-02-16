#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.31.0",
# ]
# ///
"""
Generate royalty-free AI music using the Loudly Music API.

Parametric generation:
    uv run generate_music.py --genre "House" --duration 30 --energy 0.8 --filename "output.mp3"

Text-to-music generation:
    uv run generate_music.py --prompt "upbeat electronic track" --duration 60 --filename "output.mp3"
"""

import argparse
import os
import sys
import time
from pathlib import Path

API_BASE = "https://soundtracks.loudly.com/api"
POLL_INTERVAL = 3
MAX_POLL_ATTEMPTS = 120  # 6 minutes max wait


def get_api_key(provided_key: str | None) -> str | None:
    """Get API key from argument first, then environment."""
    if provided_key:
        return provided_key
    return os.environ.get("LOUDLY_API_KEY")


def build_headers(api_key: str) -> dict:
    """Build common request headers."""
    return {
        "API-KEY": api_key,
        "Accept": "application/json",
    }


def generate_parametric(api_key: str, params: dict) -> dict:
    """Generate music using parametric controls (genre, bpm, energy, etc.)."""
    import requests

    headers = build_headers(api_key)

    # Build multipart form data from params
    form_data = {}
    for key, value in params.items():
        if value is not None:
            form_data[key] = (None, str(value))

    response = requests.post(
        f"{API_BASE}/ai/songs",
        headers=headers,
        files=form_data,
    )

    if response.status_code != 200:
        print(f"Error: API returned status {response.status_code}", file=sys.stderr)
        print(f"Response: {response.text}", file=sys.stderr)
        sys.exit(1)

    return response.json()


def generate_text_to_music(api_key: str, prompt: str, duration: int | None = None) -> dict:
    """Generate music from a text prompt."""
    import requests

    headers = build_headers(api_key)

    form_data = {"prompt": (None, prompt)}
    if duration is not None:
        form_data["duration"] = (None, str(duration))

    response = requests.post(
        f"{API_BASE}/ai/songs",
        headers=headers,
        files=form_data,
    )

    if response.status_code != 200:
        print(f"Error: API returned status {response.status_code}", file=sys.stderr)
        print(f"Response: {response.text}", file=sys.stderr)
        sys.exit(1)

    return response.json()


def poll_for_completion(api_key: str, song_id: str) -> dict | None:
    """Poll the API for song completion if generation is async."""
    import requests

    headers = build_headers(api_key)

    for attempt in range(MAX_POLL_ATTEMPTS):
        response = requests.get(
            f"{API_BASE}/ai/songs/{song_id}",
            headers=headers,
        )

        if response.status_code != 200:
            print(f"Warning: Poll returned status {response.status_code}", file=sys.stderr)
            time.sleep(POLL_INTERVAL)
            continue

        data = response.json()
        status = data.get("status", "").lower()

        if status in ("completed", "done", "ready"):
            return data
        elif status in ("failed", "error"):
            print(f"Error: Music generation failed: {data}", file=sys.stderr)
            sys.exit(1)

        print(f"  Generating... ({attempt + 1}/{MAX_POLL_ATTEMPTS})")
        time.sleep(POLL_INTERVAL)

    print("Error: Generation timed out.", file=sys.stderr)
    sys.exit(1)


def find_audio_url(data: dict) -> str | None:
    """Extract the audio download URL from the API response."""
    # Try common response field names
    for key in ("url", "audio_url", "download_url", "file_url", "mp3_url",
                "wav_url", "file", "audio", "download", "link", "src"):
        if key in data and data[key]:
            return data[key]

    # Check nested structures
    if "song" in data and isinstance(data["song"], dict):
        return find_audio_url(data["song"])
    if "data" in data and isinstance(data["data"], dict):
        return find_audio_url(data["data"])
    if "result" in data and isinstance(data["result"], dict):
        return find_audio_url(data["result"])

    # Check for list of results
    for key in ("songs", "results", "items", "tracks"):
        if key in data and isinstance(data[key], list) and len(data[key]) > 0:
            return find_audio_url(data[key][0])

    return None


def download_audio(url: str, output_path: Path) -> None:
    """Download the generated audio file."""
    import requests

    print(f"Downloading audio from: {url}")
    response = requests.get(url, stream=True)

    if response.status_code != 200:
        print(f"Error: Download failed with status {response.status_code}", file=sys.stderr)
        sys.exit(1)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)


def main():
    parser = argparse.ArgumentParser(
        description="Generate royalty-free AI music using the Loudly Music API"
    )
    parser.add_argument(
        "--prompt", "-p",
        help="Text description for text-to-music generation"
    )
    parser.add_argument(
        "--genre", "-g",
        help="Genre name (e.g. House, Ambient, Hip Hop, EDM)"
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
        type=float,
        help="Energy level between 0.0 and 1.0"
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
    parser.add_argument(
        "--api-key", "-k",
        help="Loudly API key (overrides LOUDLY_API_KEY env var)"
    )

    args = parser.parse_args()

    if not args.prompt and not args.genre:
        print("Error: Either --prompt or --genre must be provided.", file=sys.stderr)
        sys.exit(1)

    # Get API key
    api_key = get_api_key(args.api_key)
    if not api_key:
        print("Error: No API key provided.", file=sys.stderr)
        print("Please either:", file=sys.stderr)
        print("  1. Provide --api-key argument", file=sys.stderr)
        print("  2. Set LOUDLY_API_KEY environment variable", file=sys.stderr)
        sys.exit(1)

    output_path = Path(args.filename)

    # Generate music
    if args.prompt:
        print(f"Generating music from prompt: \"{args.prompt}\"")
        print(f"Duration: {args.duration}s")
        data = generate_text_to_music(api_key, args.prompt, args.duration)
    else:
        params = {
            "genre": args.genre,
            "duration": args.duration,
        }
        if args.genre_blend:
            params["genre_blend"] = args.genre_blend
        if args.energy is not None:
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
        print(f"Duration: {args.duration}s | Energy: {args.energy or 'default'} | BPM: {args.bpm or 'default'}")
        data = generate_parametric(api_key, params)

    print(f"API response: {data}")

    # If the response contains a song ID but no direct URL, poll for completion
    song_id = data.get("id") or data.get("song_id") or data.get("job_id")
    audio_url = find_audio_url(data)

    if not audio_url and song_id:
        print(f"Song ID: {song_id} — waiting for generation to complete...")
        completed_data = poll_for_completion(api_key, song_id)
        if completed_data:
            audio_url = find_audio_url(completed_data)
            data = completed_data

    if not audio_url:
        print("Error: Could not find audio URL in API response.", file=sys.stderr)
        print(f"Full response: {data}", file=sys.stderr)
        sys.exit(1)

    # Download the audio file
    download_audio(audio_url, output_path)

    full_path = output_path.resolve()
    size_kb = full_path.stat().st_size / 1024
    print(f"\nMusic saved: {full_path} ({size_kb:.1f} KB)")
    # OpenClaw parses MEDIA tokens and will attach the file on supported providers.
    print(f"MEDIA: {full_path}")


if __name__ == "__main__":
    main()
