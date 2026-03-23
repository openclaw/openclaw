# YouTube Analysis Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bundled operator1 skill that extracts metadata, transcripts, and structured analysis from YouTube videos using yt-dlp.

**Architecture:** Pure skill — `SKILL.md` + 3 Python helper scripts + 1 reference doc. No MCP, no gateway changes, no npm deps. Scripts use yt-dlp Python API and Python stdlib only.

**Tech Stack:** Python 3 (stdlib + yt-dlp), Bash (tests), operator1 skill infrastructure

**Spec:** `Project-tasks/superpowers/2026-03-19-youtube-analysis-skill-design.md`

---

## File Structure

| File                                                        | Responsibility                                                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/youtube-analysis/SKILL.md`                          | Frontmatter (eligibility, install specs) + agent workflow instructions for all 3 modes + output templates + error handling guidance     |
| `skills/youtube-analysis/scripts/fetch_video.py`            | yt-dlp wrapper: extract metadata, download subtitles (manual > auto-gen fallback), optional video download, playlist/channel resolution |
| `skills/youtube-analysis/scripts/parse_transcript.py`       | VTT/SRT parser: dedup overlapping auto-captions, output timestamped JSON segments + concatenated full text                              |
| `skills/youtube-analysis/scripts/save_analysis.py`          | Write analysis markdown to disk, handle single-video vs batch directory structure                                                       |
| `skills/youtube-analysis/references/yt-dlp-capabilities.md` | yt-dlp supported sites, key flags, Python API patterns — agent reference doc                                                            |

---

### Task 1: Create `fetch_video.py`

**Files:**

- Create: `skills/youtube-analysis/scripts/fetch_video.py`

This is the core script. Uses yt-dlp Python API to extract video metadata and download subtitles. Supports single URLs, playlists, and channels.

- [ ] **Step 1: Create the script with argument parsing**

```python
#!/usr/bin/env python3
"""Fetch video metadata and subtitles using yt-dlp.

Usage:
  fetch_video.py <url> [--download-video] [--subtitle-lang LANG] [--playlist-limit N]

Output:
  JSON to stdout with video metadata and paths to downloaded files.
"""
import argparse
import json
import os
import sys


def parse_args():
    parser = argparse.ArgumentParser(description="Fetch video metadata and subtitles via yt-dlp")
    parser.add_argument("url", help="Video, playlist, or channel URL")
    parser.add_argument("--download-video", action="store_true", help="Download full video file")
    parser.add_argument("--subtitle-lang", default="en", help="Subtitle language (default: en)")
    parser.add_argument("--playlist-limit", type=int, default=10, help="Max videos from playlist (default: 10)")
    return parser.parse_args()
```

- [ ] **Step 2: Add the yt-dlp metadata extraction function**

```python
try:
    import yt_dlp
except ImportError:
    print("[ERROR] yt-dlp is not installed. Run: brew install yt-dlp", file=sys.stderr)
    sys.exit(1)


def get_output_dir(video_id):
    base = os.path.expanduser("~/.openclaw/youtube-analysis")
    out = os.path.join(base, video_id)
    os.makedirs(out, exist_ok=True)
    return out


def fetch_single(url, subtitle_lang="en", download_video=False):
    """Extract metadata and subtitles for a single video."""

    # First pass: extract metadata without downloading
    info_opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    with yt_dlp.YoutubeDL(info_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if info is None:
        print(f"[ERROR] Could not extract info from {url}", file=sys.stderr)
        sys.exit(1)

    video_id = info.get("id", "unknown")
    out_dir = get_output_dir(video_id)

    # Save raw metadata
    metadata = {
        "video_id": video_id,
        "title": info.get("title", ""),
        "channel": info.get("channel", info.get("uploader", "")),
        "duration": info.get("duration", 0),
        "views": info.get("view_count", 0),
        "upload_date": info.get("upload_date", ""),
        "description": info.get("description", ""),
        "subtitle_file": None,
        "video_file": None,
    }

    meta_path = os.path.join(out_dir, "metadata.json")
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    # Second pass: download subtitles (and optionally video)
    dl_opts = {
        "quiet": True,
        "no_warnings": True,
        "outtmpl": os.path.join(out_dir, "%(id)s.%(ext)s"),
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": [subtitle_lang],
        "subtitlesformat": "vtt",
        "skip_download": not download_video,
    }

    if download_video:
        dl_opts["format"] = "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
        dl_opts["merge_output_format"] = "mp4"

    with yt_dlp.YoutubeDL(dl_opts) as ydl:
        ydl.download([url])

    # Find downloaded subtitle file
    for ext in ["vtt", "srt"]:
        sub_path = os.path.join(out_dir, f"{video_id}.{subtitle_lang}.{ext}")
        if os.path.exists(sub_path):
            metadata["subtitle_file"] = sub_path
            break

    # Find downloaded video file
    if download_video:
        video_path = os.path.join(out_dir, f"{video_id}.mp4")
        if os.path.exists(video_path):
            metadata["video_file"] = video_path

    # Update metadata file with paths
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    return metadata
```

- [ ] **Step 3: Add playlist/channel resolution**

```python
def fetch_playlist(url, subtitle_lang="en", download_video=False, playlist_limit=10):
    """Resolve a playlist/channel and fetch each video."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": True,
        "playlistend": playlist_limit,
    }

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if info is None:
        print(f"[ERROR] Could not extract playlist info from {url}", file=sys.stderr)
        sys.exit(1)

    entries = info.get("entries", [])
    if not entries:
        # Not a playlist — treat as single video
        return None

    playlist_title = info.get("title", "Untitled Playlist")
    videos = []
    for entry in entries[:playlist_limit]:
        entry_url = entry.get("url") or entry.get("webpage_url")
        if not entry_url:
            continue
        try:
            video = fetch_single(entry_url, subtitle_lang, download_video)
            videos.append(video)
            print(f"[OK] Fetched {len(videos)}/{min(len(entries), playlist_limit)}: {video.get('title', 'unknown')}", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] Skipping entry: {e}", file=sys.stderr)

    return {
        "playlist_title": playlist_title,
        "video_count": len(videos),
        "total_available": len(entries),
        "videos": videos,
    }


def looks_like_playlist(url):
    """Heuristic: avoid double-fetching single video URLs."""
    indicators = ["playlist?", "/playlist/", "/channel/", "/c/", "/@", "/videos", "/playlists"]
    return any(ind in url for ind in indicators)


def main():
    args = parse_args()

    result = None
    if looks_like_playlist(args.url):
        result = fetch_playlist(args.url, args.subtitle_lang, args.download_video, args.playlist_limit)

    if result is None:
        # Single video (or playlist heuristic didn't match)
        result = fetch_single(args.url, args.subtitle_lang, args.download_video)

    json.dump(result, sys.stdout, indent=2)
    print()  # trailing newline


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Make executable and test manually**

Run:

```bash
chmod +x skills/youtube-analysis/scripts/fetch_video.py
python3 skills/youtube-analysis/scripts/fetch_video.py --help
```

Expected: help text prints without errors.

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(skill): add fetch_video.py for youtube-analysis skill" skills/youtube-analysis/scripts/fetch_video.py
```

---

### Task 2: Create `parse_transcript.py`

**Files:**

- Create: `skills/youtube-analysis/scripts/parse_transcript.py`

Stdlib-only VTT/SRT parser. Deduplicates overlapping auto-caption segments and outputs structured JSON.

- [ ] **Step 1: Create the VTT/SRT parser**

```python
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
    """Remove overlapping/duplicate segments from auto-captions."""
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
```

- [ ] **Step 2: Make executable and test manually**

Run:

```bash
chmod +x skills/youtube-analysis/scripts/parse_transcript.py
python3 skills/youtube-analysis/scripts/parse_transcript.py 2>&1 || true
```

Expected: prints `Usage: parse_transcript.py <subtitle-file>` to stderr and exits with code 2.

- [ ] **Step 3: Commit**

```bash
scripts/committer "feat(skill): add parse_transcript.py for youtube-analysis skill" skills/youtube-analysis/scripts/parse_transcript.py
```

---

### Task 3: Create `save_analysis.py`

**Files:**

- Create: `skills/youtube-analysis/scripts/save_analysis.py`

Reads analysis markdown from stdin, writes to the appropriate file path.

- [ ] **Step 1: Create the save script**

```python
#!/usr/bin/env python3
"""Save analysis markdown to disk.

Usage:
  save_analysis.py --title <title> --video-id <id> [--batch-name <name>]

Input:  analysis markdown via stdin
Output: saved file path to stdout
"""
import argparse
import os
import re
import sys


def slugify(text):
    """Convert text to filesystem-safe slug."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    return text[:80]


def main():
    parser = argparse.ArgumentParser(description="Save analysis markdown to disk")
    parser.add_argument("--title", required=True, help="Video title")
    parser.add_argument("--video-id", required=True, help="Video ID")
    parser.add_argument("--batch-name", help="Batch name for grouped analysis")
    args = parser.parse_args()

    base = os.path.expanduser("~/.openclaw/youtube-analysis")

    if args.batch_name:
        batch_slug = slugify(args.batch_name)
        batch_dir = os.path.join(base, f"batch-{batch_slug}")
        if args.video_id == "synthesis":
            # Synthesis file goes at batch root, not in a subdirectory
            os.makedirs(batch_dir, exist_ok=True)
            out_path = os.path.join(batch_dir, "synthesis.md")
        else:
            out_dir = os.path.join(batch_dir, args.video_id)
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, "analysis.md")
    else:
        out_dir = os.path.join(base, args.video_id)
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, "analysis.md")

    content = sys.stdin.read()
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)

    print(out_path)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make executable and test manually**

Run:

```bash
chmod +x skills/youtube-analysis/scripts/save_analysis.py
echo "# Test" | python3 skills/youtube-analysis/scripts/save_analysis.py --title "Test" --video-id "test123"
```

Expected: prints path like `~/.openclaw/youtube-analysis/test123/analysis.md`

- [ ] **Step 3: Clean up test file and commit**

```bash
rm -rf ~/.openclaw/youtube-analysis/test123
scripts/committer "feat(skill): add save_analysis.py for youtube-analysis skill" skills/youtube-analysis/scripts/save_analysis.py
```

---

### Task 4: Create `references/yt-dlp-capabilities.md`

**Files:**

- Create: `skills/youtube-analysis/references/yt-dlp-capabilities.md`

Reference doc the agent can consult for yt-dlp capabilities beyond YouTube.

- [ ] **Step 1: Create the reference doc**

````markdown
# yt-dlp Capabilities Reference

## Supported Platforms

yt-dlp supports 1000+ sites via its extractor system. Key platforms:

- YouTube (videos, playlists, channels, shorts, live streams)
- Vimeo
- Twitter/X
- TikTok
- Bilibili
- Twitch (VODs, clips)
- Reddit (video posts)
- Instagram (reels, IGTV)
- Facebook (videos, reels)
- Dailymotion
- SoundCloud (audio)

Full list: `yt-dlp --list-extractors`

## Key Python API Patterns

### Extract metadata only (no download)

```python
import yt_dlp

with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True}) as ydl:
    info = ydl.extract_info(url, download=False)
    # info dict contains: title, channel, duration, view_count, description, etc.
```
````

### Download subtitles

```python
opts = {
    "writesubtitles": True,        # Manual subtitles
    "writeautomaticsub": True,     # Auto-generated fallback
    "subtitleslangs": ["en"],      # Language preference
    "subtitlesformat": "vtt",      # Output format
    "skip_download": True,         # Don't download video
}
```

### List available subtitles

```python
with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True}) as ydl:
    info = ydl.extract_info(url, download=False)
    subs = info.get("subtitles", {})       # Manual subs
    auto_subs = info.get("automatic_captions", {})  # Auto-generated
```

### Playlist resolution

```python
opts = {
    "extract_flat": True,     # Don't download, just list entries
    "playlistend": 10,        # Limit entries
}
```

### Cookie-based auth (private/member content)

```python
opts = {
    "cookiesfrombrowser": ("chrome",),  # Read cookies from Chrome
}
```

## Useful CLI Flags (for agent reference)

| Flag                            | Purpose                                    |
| ------------------------------- | ------------------------------------------ |
| `--list-subs`                   | Show available subtitle languages          |
| `--print-json`                  | Print metadata as JSON without downloading |
| `--flat-playlist`               | List playlist entries without downloading  |
| `--cookies-from-browser chrome` | Auth via browser cookies                   |
| `--geo-bypass`                  | Bypass geographic restrictions             |
| `--proxy URL`                   | Route through proxy                        |

````

- [ ] **Step 2: Commit**

```bash
scripts/committer "docs(skill): add yt-dlp capabilities reference for youtube-analysis" skills/youtube-analysis/references/yt-dlp-capabilities.md
````

---

### Task 5: Create `SKILL.md`

**Files:**

- Create: `skills/youtube-analysis/SKILL.md`

The main skill file — frontmatter + full agent workflow instructions.

- [ ] **Step 1: Create SKILL.md with frontmatter and workflow**

````markdown
---
name: youtube-analysis
description: "Analyze YouTube videos, playlists, and channels. Extracts metadata, transcripts, and produces structured analysis with chapter breakdowns, key topics, notable quotes, and cross-video synthesis. Supports any yt-dlp-compatible platform."
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "emoji": "📺",
        "requires": { "bins": ["yt-dlp", "python3"] },
        "install":
          [
            {
              "id": "yt-dlp-brew",
              "kind": "brew",
              "formula": "yt-dlp",
              "bins": ["yt-dlp"],
              "label": "Install yt-dlp (brew)",
            },
            {
              "id": "ffmpeg-brew",
              "kind": "brew",
              "formula": "ffmpeg",
              "bins": ["ffmpeg"],
              "label": "Install FFmpeg (brew, optional for frame extraction)",
            },
          ],
      },
  }
---

# YouTube Analysis

Analyze videos from YouTube and 1000+ other platforms supported by yt-dlp. Extract metadata, transcripts, and produce structured analysis.

**Disambiguation:** Use this skill when the user wants structured video analysis (chapters, topics, quotes, batch research). Use `summarize` when yt-dlp is unavailable or the user just wants a quick summary.

## Mode 1: Single Video Analysis (default)

When the user provides a video URL and wants analysis:

1. **Fetch metadata and subtitles:**
   ```bash
   python3 {baseDir}/scripts/fetch_video.py "<url>"
   ```
````

Output: JSON with video metadata and path to downloaded subtitle file.

2. **Parse transcript:**

   ```bash
   python3 {baseDir}/scripts/parse_transcript.py "<subtitle_file>"
   ```

   Output: JSON with timestamped segments and full text.

3. **If no subtitles were found** (`subtitle_file` is null):
   Suggest using the `openai-whisper-api` skill to transcribe audio. Download audio first:

   ```bash
   python3 {baseDir}/scripts/fetch_video.py "<url>" --download-video
   ```

4. **Analyze the transcript** and produce structured output using the template below.

5. **If user requests save:**
   ```bash
   echo "<analysis_markdown>" | python3 {baseDir}/scripts/save_analysis.py --title "<title>" --video-id "<video_id>"
   ```

## Mode 2: Batch/Playlist Research

When the user provides multiple URLs, a playlist URL, or a channel URL:

1. **Fetch all videos:**

   ```bash
   python3 {baseDir}/scripts/fetch_video.py "<playlist_url>" --playlist-limit 10
   ```

   Output: JSON with playlist info and array of video metadata.

2. **Parse each video's transcript** using `parse_transcript.py`.

3. **Analyze each video** individually using the single-video template.

4. **Synthesize across videos:** After all individual analyses, produce a cross-video synthesis covering common themes, key differences/contradictions, and overall takeaways.

5. **Auto-save all results** (batch always saves):
   ```bash
   echo "<per_video_analysis>" | python3 {baseDir}/scripts/save_analysis.py --title "<title>" --video-id "<video_id>" --batch-name "<batch_name>"
   echo "<synthesis>" | python3 {baseDir}/scripts/save_analysis.py --title "Synthesis" --video-id "synthesis" --batch-name "<batch_name>"
   ```

## Mode 3: Deep Analysis (opt-in)

Only when user explicitly requests visual/deep analysis:

1. Download full video:

   ```bash
   python3 {baseDir}/scripts/fetch_video.py "<url>" --download-video
   ```

2. Check if `ffmpeg` is available. If not, offer to install via the skill install spec.

3. Extract keyframes using the `video-frames` skill or directly:

   ```bash
   ffmpeg -i "<video_file>" -vf "select=eq(pict_type\,I)" -vsync vfr "<output_dir>/frame_%04d.jpg"
   ```

4. Analyze frames alongside transcript for visual context.

5. Include speaker pattern identification and sentiment/tone analysis.

## Output Template

Use this format for every single-video analysis:

```
# Video Analysis: <title>

**Channel:** <channel> | **Duration:** <duration> | **Views:** <views> | **Uploaded:** <date>
**URL:** <url>

## TL;DR
2-3 sentence summary.

## Chapters
(Derived from YouTube chapter markers if present, otherwise segment transcript by topic shifts)
| Time | Chapter | Summary |
|------|---------|---------|
| 0:00 | Introduction | ... |

## Key Topics & Themes
- Topic 1 — brief description

## Main Arguments & Claims
- Claim 1 (timestamp)

## Notable Quotes
> "Quote text" — timestamp

## Resources & Links Mentioned
- Resource 1 (if any mentioned in video)
```

For batch synthesis, add:

```
# Cross-Video Synthesis

## Common Themes
## Key Differences & Contradictions
## Overall Takeaways
```

## Error Handling

- **No subtitles:** Suggest Whisper fallback via `openai-whisper-api` skill.
- **Private/age-restricted video:** Inform user. Cookie auth: `python3 {baseDir}/scripts/fetch_video.py "<url>"` — the script can be modified to pass `cookiesfrombrowser: ("chrome",)` in ydl_opts.
- **Rate limited:** Wait 30 seconds, retry once, then inform user.
- **Video > 3 hours:** Warn about transcript size, offer to analyze first N minutes.
- **Playlist > 10 videos:** Process first 10, inform user of remaining count.
- **FFmpeg missing (deep mode):** Inform user, offer install.

## Reference

See `{baseDir}/references/yt-dlp-capabilities.md` for supported platforms, Python API patterns, and CLI flags.

````

- [ ] **Step 2: Commit**

```bash
scripts/committer "feat(skill): add SKILL.md for youtube-analysis skill" skills/youtube-analysis/SKILL.md
````

---

### Task 6: Integration Test — End-to-End Verification

**Files:**

- Read: `skills/youtube-analysis/SKILL.md` (verify structure)
- Read: `skills/youtube-analysis/scripts/*.py` (verify all scripts)

Verify the complete skill works as a unit.

- [ ] **Step 1: Verify skill directory structure**

Run:

```bash
find skills/youtube-analysis -type f | sort
```

Expected:

```
skills/youtube-analysis/SKILL.md
skills/youtube-analysis/references/yt-dlp-capabilities.md
skills/youtube-analysis/scripts/fetch_video.py
skills/youtube-analysis/scripts/parse_transcript.py
skills/youtube-analysis/scripts/save_analysis.py
```

- [ ] **Step 2: Verify all scripts are executable**

Run:

```bash
ls -la skills/youtube-analysis/scripts/*.py
```

Expected: all have `-rwxr-xr-x` permissions.

- [ ] **Step 3: Verify SKILL.md frontmatter parses correctly**

Run:

```bash
head -30 skills/youtube-analysis/SKILL.md
```

Expected: valid YAML frontmatter with `name: youtube-analysis`, `requires.bins`, and install specs.

- [ ] **Step 4: Test fetch_video.py with a real URL (optional — requires yt-dlp installed)**

Run:

```bash
python3 skills/youtube-analysis/scripts/fetch_video.py "https://www.youtube.com/watch?v=dQw4w9WgXcQ" 2>/dev/null | python3 -m json.tool | head -20
```

Expected: valid JSON with `video_id`, `title`, `channel`, `duration`, `subtitle_file`.

- [ ] **Step 5: Test parse_transcript.py with the downloaded subtitle file**

Run (using the subtitle_file path from step 4):

```bash
python3 skills/youtube-analysis/scripts/parse_transcript.py ~/.openclaw/youtube-analysis/dQw4w9WgXcQ/*.vtt 2>/dev/null | python3 -m json.tool | head -20
```

Expected: valid JSON with `segments` array and `full_text`.

- [ ] **Step 6: Test save_analysis.py**

Run:

```bash
echo "# Test Analysis" | python3 skills/youtube-analysis/scripts/save_analysis.py --title "Test" --video-id "test-e2e"
cat ~/.openclaw/youtube-analysis/test-e2e/analysis.md
rm -rf ~/.openclaw/youtube-analysis/test-e2e
```

Expected: prints path, file contains `# Test Analysis`.

- [ ] **Step 7: Verify skill is discovered by the gateway**

Run:

```bash
pnpm openclaw skills list 2>/dev/null | grep -i youtube
```

Expected: `youtube-analysis` appears in the skill list with the 📺 emoji.

- [ ] **Step 8: Final commit with all files**

If any files were adjusted during testing:

```bash
scripts/committer "feat(skill): youtube-analysis skill - complete implementation" skills/youtube-analysis/
```

- [ ] **Step 9: Clean up test artifacts**

```bash
rm -rf ~/.openclaw/youtube-analysis/dQw4w9WgXcQ
```
