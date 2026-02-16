#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests>=2.31.0",
# ]
# ///
"""
List available genres from the Loudly Music API.

Usage:
    uv run list_genres.py [--api-key KEY]
"""

import argparse
import os
import sys


API_BASE = "https://soundtracks.loudly.com/api"


def main():
    parser = argparse.ArgumentParser(description="List available Loudly music genres")
    parser.add_argument("--api-key", "-k", help="Loudly API key (overrides LOUDLY_API_KEY env var)")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("LOUDLY_API_KEY")
    if not api_key:
        print("Error: No API key. Set LOUDLY_API_KEY or pass --api-key.", file=sys.stderr)
        sys.exit(1)

    import requests

    response = requests.get(
        f"{API_BASE}/ai/genres",
        headers={"API-KEY": api_key, "Accept": "application/json"},
    )

    if response.status_code != 200:
        print(f"Error: API returned status {response.status_code}", file=sys.stderr)
        print(f"Response: {response.text}", file=sys.stderr)
        sys.exit(1)

    data = response.json()

    # Handle different response shapes
    genres = data if isinstance(data, list) else data.get("genres", data.get("data", []))

    if not genres:
        print("No genres found. Raw response:")
        print(data)
        return

    print("Available Loudly Genres:")
    print("=" * 50)
    for genre in genres:
        if isinstance(genre, dict):
            name = genre.get("name", genre.get("title", "Unknown"))
            bpm_min = genre.get("bpm_min", genre.get("minBpm", ""))
            bpm_max = genre.get("bpm_max", genre.get("maxBpm", ""))
            bpm_range = f" ({bpm_min}-{bpm_max} BPM)" if bpm_min and bpm_max else ""
            desc = genre.get("description", "")
            print(f"  {name}{bpm_range}")
            if desc:
                print(f"    {desc}")

            # Print sub-genres / micro-genres if present
            sub = genre.get("micro_genres", genre.get("subgenres", genre.get("children", [])))
            if sub:
                for sg in sub:
                    sg_name = sg.get("name", sg) if isinstance(sg, dict) else sg
                    print(f"    - {sg_name}")
        else:
            print(f"  {genre}")

    print(f"\nTotal: {len(genres)} genres")


if __name__ == "__main__":
    main()
