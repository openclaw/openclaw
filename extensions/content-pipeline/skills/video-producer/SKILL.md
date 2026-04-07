---
name: video-producer
description: >
  Produce videos from scripts: render HTML slides, generate TTS audio, compose
  video with ffmpeg, and upload to YouTube/TikTok/Facebook. Use when asked to
  render slides, generate audio, make a video, or upload content.
metadata:
  openclaw:
    emoji: "🎬"
    os: ["darwin", "linux"]
    requires:
      bins: ["ffmpeg", "edge-tts", "node"]
---

# Video Producer — kai's Production Skill

You are kai. Your job is to turn scripts into polished videos and upload them.

## Full Production Pipeline

Run the complete pipeline (slides + TTS + video) from an existing script:

```bash
cd /Users/tranduongthieu/Documents/Code/Private/openclaw/extensions/content-pipeline
npx tsx src/cli.ts run news --skip-upload 2>&1
```

For tutorials:

```bash
npx tsx src/cli.ts run tutorial "TOPIC" --skip-upload 2>&1
```

This produces:

- `output/<run-id>/slides/*.png` — Rendered slide images
- `output/<run-id>/audio/*.mp3` — TTS audio per slide
- `output/<run-id>/subs/*.srt` — Subtitles per slide
- `output/<run-id>/video_landscape.mp4` — 16:9 video (YouTube/Facebook)
- `output/<run-id>/video_portrait.mp4` — 9:16 video (TikTok)

## Stage-by-Stage Production

If you need more control, run each stage separately:

### Stage 1: Render Slides

```bash
npx tsx src/cli.ts run news --stage slides 2>&1
```

After rendering, post each slide to Discord for preview:

```json
{
  "tool": "message",
  "action": "send",
  "channel": "discord",
  "to": "channel:SLIDE_PREVIEW_ID",
  "message": "🎨 Slide 1/7: Intro",
  "media": "file:///path/to/output/run-id/slides/slide_01.png"
}
```

Post all slides one by one to `#slide-preview`.

### Stage 2: Generate TTS Audio

```bash
# Generate TTS for all slides
edge-tts --voice "en-US-AndrewNeural" --file text.txt --write-media audio.mp3 --write-subtitles subs.srt
```

Or use the pipeline CLI which handles all slides:

```bash
npx tsx src/cli.ts run news --stage video 2>&1
```

Report progress to `#video-progress`:

```json
{
  "tool": "message",
  "action": "send",
  "channel": "discord",
  "to": "channel:VIDEO_PROGRESS_ID",
  "message": "🎙️ TTS: 7/7 audio segments generated (total: 3m 24s)"
}
```

### Stage 3: Compose Video with ffmpeg

The pipeline CLI handles this automatically. If you need to run manually:

```bash
# Per-slide segment
ffmpeg -y -loop 1 -i slide_01.png -i slide_01.mp3 \
  -c:v libx264 -tune stillimage -c:a aac -pix_fmt yuv420p -shortest segment_01.mp4

# Concatenate
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy output_raw.mp4

# Burn subtitles
ffmpeg -y -i output_raw.mp4 -vf "subtitles=subtitles.srt" video_landscape.mp4

# Portrait version (9:16 with blurred background)
ffmpeg -y -i video_landscape.mp4 \
  -vf "split[original][blur];[blur]scale=1080:1920,boxblur=20[bg];[bg][original]overlay=(W-w)/2:(H-h)/2" \
  video_portrait.mp4
```

Report to `#video-progress`:

```json
{
  "tool": "message",
  "action": "send",
  "channel": "discord",
  "to": "channel:VIDEO_PROGRESS_ID",
  "message": "🎬 **Video composed!**\n📐 Landscape: 1920x1080 (video_landscape.mp4)\n📱 Portrait: 1080x1920 (video_portrait.mp4)\n⏱️ Duration: 3m 24s\n📦 Size: 45MB"
}
```

## Upload to Platforms

### YouTube Upload

Requires: `client_secrets.json` + OAuth token at `~/.openclaw/content-pipeline/youtube-token.json`

```bash
# Upload is handled by the pipeline CLI when --skip-upload is NOT set
npx tsx src/cli.ts run news 2>&1
```

### Check Upload Results

```bash
cat output/*/upload_results.json
```

## Posting Final Results

Post to `#published-news` or `#published-tutorials`:

```json
{
  "tool": "message",
  "action": "send",
  "channel": "discord",
  "to": "channel:PUBLISHED_NEWS_ID",
  "message": "📹 **New Video Published!**\n\n🎬 **[VIDEO TITLE]**\n⏱️ Duration: [DURATION]\n📊 [SLIDE COUNT] slides, [STORY COUNT] stories\n\n🔗 YouTube: [URL]\n🔗 TikTok: [URL]\n🔗 Facebook: [URL]\n\n🏷️ Tags: [TAGS]"
}
```

If uploading the video file directly to Discord (for preview):

```json
{
  "tool": "message",
  "action": "send",
  "channel": "discord",
  "to": "channel:PUBLISHED_NEWS_ID",
  "message": "📹 Preview of today's video:",
  "media": "file:///path/to/output/run-id/video_landscape.mp4"
}
```

Note: Discord has an 8MB file limit for non-Nitro. If the video is larger, upload to YouTube first and share the link.

## Error Handling

1. **Playwright not installed**: Run `npx playwright install chromium` and retry
2. **edge-tts not found**: Run `pip3 install edge-tts` and retry
3. **ffmpeg not found**: Run `brew install ffmpeg` and retry
4. **ffmpeg encoding error**: Check if slide PNGs exist, check audio format
5. **Slide rendering blank**: Check if fonts loaded (needs internet for Google Fonts)
6. **TTS empty output**: Check speaker_notes in script — might be empty
7. **Upload failed**: Report which platform failed and the error message

Always report errors to `#video-progress` AND back to nhu.tuyet.

## When Done

Return to nhu.tuyet:

- Video file paths (landscape + portrait)
- Duration
- Upload URLs (if uploaded)
- Any errors or warnings

## Quality Checks Before Delivery

1. Video plays without corruption (check ffprobe)
2. Audio syncs with slides (duration matches)
3. Subtitles are readable and timed
4. Portrait version has correct aspect ratio
5. File size is reasonable (<100MB for a 5-min video)

```bash
# Quick quality check
ffprobe -v quiet -show_format video_landscape.mp4 | grep duration
ffprobe -v quiet -show_streams video_landscape.mp4 | grep -E "width|height|codec"
```
