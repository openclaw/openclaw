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
