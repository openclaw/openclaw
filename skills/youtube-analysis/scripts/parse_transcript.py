#!/usr/bin/env python3
"""Parse VTT or SRT subtitle files into structured JSON.

Usage:
  parse_transcript.py <subtitle-file>

Output:
  JSON to stdout with timestamped segments and concatenated full text.
"""
import json
import os
import re
import sys


def parse_timestamp(ts):
    """Convert VTT/SRT timestamp to seconds."""
    ts = ts.strip().replace(",", ".")
    parts = ts.split(":")
    if len(parts) == 3:
        h, m, s = parts
        return int(h) * 3600 + int(m) * 60 + float(s)
    elif len(parts) == 2:
        m, s = parts
        return int(m) * 60 + float(s)
    return 0.0


def format_timestamp(seconds):
    """Convert seconds to zero-padded HH:MM:SS format."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def parse_vtt(content):
    """Parse VTT content into raw segments."""
    segments = []
    # Remove VTT header
    content = re.sub(r"^WEBVTT.*?\n\n", "", content, flags=re.DOTALL)
    # Remove NOTE blocks
    content = re.sub(r"NOTE.*?\n\n", "", content, flags=re.DOTALL)

    # Match timestamp lines and their text
    pattern = re.compile(
        r"(\d{1,3}:[\d:.]+)\s*-->\s*(\d{1,3}:[\d:.]+).*?\n((?:(?!\d{1,3}:[\d:.]+\s*-->).+\n?)*)",
        re.MULTILINE,
    )

    for match in pattern.finditer(content):
        start = parse_timestamp(match.group(1))
        end = parse_timestamp(match.group(2))
        text = match.group(3).strip()
        # Remove VTT formatting tags
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            segments.append({"start": start, "end": end, "text": text})

    return segments


def parse_srt(content):
    """Parse SRT content into raw segments."""
    segments = []
    blocks = re.split(r"\n\s*\n", content.strip())

    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 3:
            continue
        # Skip index line
        ts_match = re.match(r"(\d{2}:[\d:,]+)\s*-->\s*(\d{2}:[\d:,]+)", lines[1])
        if not ts_match:
            continue
        start = parse_timestamp(ts_match.group(1))
        end = parse_timestamp(ts_match.group(2))
        text = " ".join(lines[2:]).strip()
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            segments.append({"start": start, "end": end, "text": text})

    return segments


def deduplicate_segments(segments):
    """Remove overlapping/duplicate segments from auto-captions.

    Auto-generated captions often use a rolling-window pattern where each segment
    progressively reveals more text. Segments within ~2 seconds of each other
    where one is a prefix of the other are treated as progressive reveals.
    """
    if not segments:
        return []

    deduped = [segments[0]]
    for seg in segments[1:]:
        prev = deduped[-1]
        # Skip if text is identical or nearly identical to previous
        if seg["text"] == prev["text"]:
            # Extend previous segment's end time
            prev["end"] = max(prev["end"], seg["end"])
            continue
        # Skip if this segment's text is a substring of previous (auto-caption overlap)
        if seg["text"] in prev["text"]:
            continue
        # If previous text is a prefix of current, replace with current (progressive reveal)
        if prev["text"] in seg["text"] and seg["start"] - prev["start"] < 2.0:
            prev["text"] = seg["text"]
            prev["end"] = seg["end"]
            continue
        deduped.append(seg)

    return deduped


def main():
    if len(sys.argv) < 2:
        print("Usage: parse_transcript.py <subtitle-file>", file=sys.stderr)
        sys.exit(2)

    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(f"[ERROR] File not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # Detect format
    if filepath.endswith(".vtt") or content.startswith("WEBVTT"):
        segments = parse_vtt(content)
    else:
        segments = parse_srt(content)

    # Deduplicate auto-caption overlaps
    segments = deduplicate_segments(segments)

    # Format output
    output_segments = [
        {
            "start": format_timestamp(s["start"]),
            "end": format_timestamp(s["end"]),
            "text": s["text"],
        }
        for s in segments
    ]

    full_text = " ".join(s["text"] for s in segments)

    result = {
        "segments": output_segments,
        "full_text": full_text,
    }

    # Save to transcript.json alongside the subtitle file
    out_dir = os.path.dirname(filepath)
    transcript_path = os.path.join(out_dir, "transcript.json")
    with open(transcript_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    # Also output to stdout for the agent
    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
