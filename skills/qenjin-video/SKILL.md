---
name: qenjin-video
description: Video editing pipeline — clip extraction, captioning, aspect ratio conversion, batch processing.
user-invocable: true
disable-model-invocation: false
triggers:
  - /video
  - /clip
  - /edit
---

# qenjin-video

Video editing pipeline. Clip extraction, captioning, aspect ratio conversion, batch processing.

Dependencies: `ffmpeg`, `yt-dlp`, `scenedetect`, `whisper`.
Output: S3 `hudafilm-media` bucket at `https://nbg1.your-objectstorage.com`.

## On `/video clip [url] [start] [end]`

Extract clip from video file or URL.

```bash
python3 -c "
import sys, subprocess, os

if len(sys.argv) < 4:
    print('Usage: /video clip <url-or-file> <start> <end>')
    print('  start/end format: HH:MM:SS or seconds')
    exit()

source = sys.argv[1]
start = sys.argv[2]
end = sys.argv[3]
output = f'clip_{start.replace(\":\",\"\")}-{end.replace(\":\",\"\")}.mp4'

# If URL, download first
if source.startswith('http'):
    print(f'Downloading: {source}')
    subprocess.run(['yt-dlp', '-o', 'source_video.mp4', '--no-playlist', source], check=True)
    source = 'source_video.mp4'

# Extract clip
subprocess.run([
    'ffmpeg', '-y', '-i', source,
    '-ss', start, '-to', end,
    '-c:v', 'libx264', '-c:a', 'aac',
    '-movflags', '+faststart',
    output
], check=True)

size_mb = os.path.getsize(output) / (1024*1024)
print(f'Clipped: {output} ({size_mb:.1f} MB)')
" <url> <start> <end>
```

Reply: `Clipped: <filename> (<size> MB)`

## On `/video article [substack-url]`

Generate 4 clip scripts with timestamps from a Substack article.

Fetch article content, then generate:

1. **Number Hook** (30-45s): Lead with the hardest number. One stat, one implication.
2. **Myth vs Fact** (45-60s): State the myth, pause, deliver the data.
3. **Science Plain** (60-90s): Mechanism at grade 7 level. One analogy max.
4. **Local Angle** (45-60s): South Dakota or Sioux Falls connection.

Reply format:
```
Article: <title>
━━━━━━━━━━━━━━━━━━━━━━━━━━━

CLIP 1 — Number Hook (30-45s)
Script: <teleprompter-ready text>

CLIP 2 — Myth vs Fact (45-60s)
Script: <teleprompter-ready text>

CLIP 3 — Science Plain (60-90s)
Script: <teleprompter-ready text>

CLIP 4 — Local Angle (45-60s)
Script: <teleprompter-ready text>
```

Voice: calm, precise. No em dashes. Short sentences land facts.

## On `/video youtube [url]`

Download video and auto-detect scene boundaries.

```bash
python3 -c "
import sys, subprocess

if len(sys.argv) < 2:
    print('Usage: /video youtube <url>')
    exit()

url = sys.argv[1]
output = 'downloaded_video.mp4'

# Download
print(f'Downloading: {url}')
subprocess.run([
    'yt-dlp', '-o', output,
    '--no-playlist',
    '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '--merge-output-format', 'mp4',
    url
], check=True)

# Scene detection
print('Detecting scenes...')
subprocess.run([
    'scenedetect', '-i', output,
    'detect-adaptive', '--threshold', '27',
    'list-scenes'
], check=True)

print('Done. Review scene list for clip boundaries.')
" <url>
```

Reply: download confirmation, then scene boundary list.

## On `/video caption [file]`

Generate and burn captions using Whisper.

```bash
python3 -c "
import sys, subprocess, os

if len(sys.argv) < 2:
    print('Usage: /video caption <file>')
    exit()

source = sys.argv[1]
srt_file = source.rsplit('.', 1)[0] + '.srt'
output = source.rsplit('.', 1)[0] + '_captioned.mp4'

# Transcribe with Whisper
print(f'Transcribing: {source}')
subprocess.run([
    'whisper', source,
    '--model', 'base',
    '--output_format', 'srt',
    '--output_dir', '.'
], check=True)

# Burn captions
print('Burning captions...')
subprocess.run([
    'ffmpeg', '-y', '-i', source,
    '-vf', f\"subtitles={srt_file}:force_style='FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2'\",
    '-c:v', 'libx264', '-c:a', 'aac',
    output
], check=True)

size_mb = os.path.getsize(output) / (1024*1024)
print(f'Captioned: {output} ({size_mb:.1f} MB)')
" <file>
```

Reply: `Captioned: <filename> (<size> MB)`

## On `/video resize [file] [ratio]`

Convert aspect ratio with smart crop.

Supported ratios: `9:16` (Reels/TikTok), `1:1` (Instagram), `16:9` (YouTube).

```bash
python3 -c "
import sys, subprocess, os

if len(sys.argv) < 3:
    print('Usage: /video resize <file> <ratio>')
    print('  Ratios: 9:16, 1:1, 16:9')
    exit()

source = sys.argv[1]
ratio = sys.argv[2]
name = source.rsplit('.', 1)[0]
ext = source.rsplit('.', 1)[1] if '.' in source else 'mp4'
output = f'{name}_{ratio.replace(\":\",\"x\")}.{ext}'

# Map ratio to ffmpeg crop/scale filter
filters = {
    '9:16': 'crop=ih*9/16:ih,scale=1080:1920',
    '1:1': 'crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080',
    '16:9': 'crop=iw:iw*9/16,scale=1920:1080',
}

vf = filters.get(ratio)
if not vf:
    print(f'Unknown ratio: {ratio}. Use 9:16, 1:1, or 16:9.')
    exit()

subprocess.run([
    'ffmpeg', '-y', '-i', source,
    '-vf', vf,
    '-c:v', 'libx264', '-c:a', 'aac',
    '-movflags', '+faststart',
    output
], check=True)

size_mb = os.path.getsize(output) / (1024*1024)
print(f'Resized: {output} ({size_mb:.1f} MB)')
" <file> <ratio>
```

Reply: `Resized: <filename> (<size> MB)`

## On `/video batch [article-id]`

Full pipeline: 4 clips x 3 ratios x captions = 12 deliverables.

Steps:
1. Generate 4 clip scripts from article (same as `/video article`)
2. For each clip: extract segment from source video
3. For each clip: generate 3 aspect ratios (9:16, 1:1, 16:9)
4. For each variant: burn captions via Whisper
5. Upload all to S3 hudafilm-media bucket

```bash
python3 -c "
import sys
article_id = sys.argv[1] if len(sys.argv) > 1 else ''
if not article_id:
    print('Usage: /video batch <article-id>')
    exit()

print(f'Batch pipeline for article: {article_id}')
print()
print('Pipeline:')
print('  1. 4 clips from article')
print('  2. 3 ratios each (9:16, 1:1, 16:9)')
print('  3. Captions on all variants')
print('  4. Upload to S3')
print()
print('12 deliverables total.')
print('Estimated time: 15-30 min depending on source length.')
" <article-id>
```

Upload command:
```bash
aws s3 cp <file> s3://hudafilm-media/clips/<article-id>/ --endpoint-url https://nbg1.your-objectstorage.com --acl public-read
```

Reply: progress updates, then final count with S3 URLs.

## On `/video status`

Processing queue status.

```bash
python3 -c "
import os, glob

# Check for in-progress files
mp4s = glob.glob('*.mp4')
srts = glob.glob('*.srt')
print(f'Local files: {len(mp4s)} videos, {len(srts)} subtitle files')

# Check running ffmpeg/yt-dlp processes
import subprocess
r = subprocess.run(['ps', 'aux'], capture_output=True, text=True)
lines = r.stdout.splitlines()
active = [l for l in lines if 'ffmpeg' in l or 'yt-dlp' in l or 'whisper' in l]
print(f'Active processes: {len(active)}')
for p in active:
    parts = p.split()
    cmd = ' '.join(parts[10:13]) if len(parts) > 12 else ' '.join(parts[-3:])
    print(f'  {cmd}')

if not active:
    print('Queue empty.')
"
```

Reply: file counts, active processes. `Queue empty.` if nothing running.

## Rules

- File sizes in MB. Durations in seconds.
- Never re-encode unnecessarily. Use `-c copy` when no filter is applied.
- Max resolution: 1080p for all outputs.
- S3 uploads always use `--acl public-read` to hudafilm-media bucket.
- Caption style: white text, black outline, bottom-center aligned.
- Never expose S3 credentials in replies.
- All video voice rules match content skill: calm, precise, no em dashes.
- "Done." is a complete response when appropriate.
