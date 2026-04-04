#!/usr/bin/env python3
"""
build_manifest.py — CBCS Manifest Generator for Thinker Cafe Soundscape

Reads classified pool WAVs from ~/.soundscape/pools/,
splits into small units, extracts features, encodes to MP3,
and generates soundscape_manifest.json.

Pools expected:
  ~/.soundscape/pools/keynote/*.wav
  ~/.soundscape/pools/signal/*.wav
  ~/.soundscape/pools/soundmark/*.wav

Output:
  public/cafe-game/assets/units/*.mp3
  public/cafe-game/assets/soundscape_manifest.json
"""

import json
import os
import sys
from pathlib import Path

try:
    import librosa
    import numpy as np
    import soundfile as sf
except ImportError:
    print("Missing dependencies. Install with: pip install librosa numpy soundfile")
    sys.exit(1)

try:
    from pydub import AudioSegment
except ImportError:
    print("Missing pydub. Install with: pip install pydub")
    print("Also ensure ffmpeg is installed (brew install ffmpeg).")
    sys.exit(1)


# ── Configuration ────────────────────────────────────────────────
POOLS_DIR = Path.home() / ".soundscape" / "pools"
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent.parent  # projects/website
OUTPUT_UNITS = PROJECT_DIR / "public" / "cafe-game" / "assets" / "units"
OUTPUT_MANIFEST = PROJECT_DIR / "public" / "cafe-game" / "assets" / "soundscape_manifest.json"

UNIT_DURATION = 8       # seconds per unit (target: 5-10s)
UNIT_OVERLAP = 1        # overlap for smoother cuts
MP3_BITRATE = "96k"
SAMPLE_RATE = 22050

POOL_NAMES = ["keynote", "signal", "soundmark"]
POOL_PREFIX = {"keynote": "k", "signal": "s", "soundmark": "m"}


def split_audio(y, sr, duration=UNIT_DURATION, overlap=UNIT_OVERLAP):
    """Split audio array into chunks of `duration` seconds with overlap."""
    chunk_samples = int(duration * sr)
    hop_samples = int((duration - overlap) * sr)
    chunks = []
    start = 0
    while start + chunk_samples <= len(y):
        chunks.append(y[start:start + chunk_samples])
        start += hop_samples
    # Include tail if it's at least half the target duration
    if start < len(y) and (len(y) - start) >= chunk_samples // 2:
        chunk = y[start:]
        chunks.append(chunk)
    return chunks


def extract_features(y, sr):
    """Extract spectral centroid (mean) and RMS (mean) from audio chunk."""
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
    rms = librosa.feature.rms(y=y)
    return {
        "centroid": round(float(np.mean(centroid)), 1),
        "rms": round(float(np.mean(rms)), 6),
    }


def encode_mp3(y, sr, output_path, bitrate=MP3_BITRATE):
    """Write audio array to MP3 via pydub."""
    # Write temp WAV first
    tmp_wav = str(output_path) + ".tmp.wav"
    sf.write(tmp_wav, y, sr)
    try:
        audio = AudioSegment.from_wav(tmp_wav)
        audio.export(str(output_path), format="mp3", bitrate=bitrate)
    finally:
        if os.path.exists(tmp_wav):
            os.remove(tmp_wav)


def process_pool(pool_name):
    """Process all WAVs in a pool directory, return list of unit entries."""
    pool_dir = POOLS_DIR / pool_name
    if not pool_dir.exists():
        print(f"  [skip] {pool_dir} does not exist")
        return []

    wav_files = sorted(pool_dir.glob("*.wav"))
    if not wav_files:
        print(f"  [skip] No WAV files in {pool_dir}")
        return []

    prefix = POOL_PREFIX[pool_name]
    units = []
    unit_idx = 0

    for wav_path in wav_files:
        print(f"  Processing {wav_path.name}...")
        try:
            y, sr = librosa.load(str(wav_path), sr=SAMPLE_RATE, mono=True)
        except Exception as e:
            print(f"  [error] Could not load {wav_path.name}: {e}")
            continue

        chunks = split_audio(y, sr)
        print(f"    -> {len(chunks)} units")

        for chunk in chunks:
            features = extract_features(chunk, sr)
            filename = f"{prefix}_{unit_idx:02d}.mp3"
            output_path = OUTPUT_UNITS / filename

            encode_mp3(chunk, sr, output_path)

            # Guess hour from filename or use noon as default
            # If the source filename contains an hour hint like "h11", extract it
            hour = 12  # default
            stem = wav_path.stem.lower()
            for part in stem.replace("_", " ").replace("-", " ").split():
                if part.startswith("h") and part[1:].isdigit():
                    hour = int(part[1:]) % 24
                    break

            units.append({
                "file": filename,
                "pool": pool_name,
                "centroid": features["centroid"],
                "rms": features["rms"],
                "hour": hour,
            })
            unit_idx += 1

    return units


def main():
    print(f"CBCS Manifest Builder")
    print(f"Pools dir: {POOLS_DIR}")
    print(f"Output:    {OUTPUT_UNITS}")
    print()

    # Ensure output directory exists
    OUTPUT_UNITS.mkdir(parents=True, exist_ok=True)

    all_units = []
    for pool in POOL_NAMES:
        print(f"[{pool}]")
        units = process_pool(pool)
        all_units.extend(units)
        print(f"  -> {len(units)} units generated")
        print()

    # Write manifest
    manifest = {"units": all_units}
    OUTPUT_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"Done. {len(all_units)} total units.")
    print(f"Manifest: {OUTPUT_MANIFEST}")


if __name__ == "__main__":
    main()
