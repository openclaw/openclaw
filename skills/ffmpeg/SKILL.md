---
name: ffmpeg
description: Video and audio editing — trim, convert, filter, merge, extract audio, create GIFs, and inspect media.
homepage: https://ffmpeg.org
metadata:
  {
    "openclaw":
      {
        "emoji": "🎬",
        "requires": { "bins": ["ffmpeg", "ffprobe"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "ffmpeg",
              "bins": ["ffmpeg", "ffprobe"],
              "label": "Install ffmpeg (brew)",
            },
          ],
      },
  }
---

# ffmpeg CLI

Use `ffmpeg` and `ffprobe` for video/audio editing, conversion, and inspection.

## Quick start

Inspect a file:

```bash
ffprobe -v error -show_format -show_streams input.mp4
```

Convert format:

```bash
ffmpeg -hide_banner -y -i input.mp4 output.webm
```

Trim (fast, no re-encode):

```bash
ffmpeg -hide_banner -y -ss 00:00:10 -i input.mp4 -t 00:00:30 -c copy output.mp4
```

## Media inspection (ffprobe)

Duration, resolution, codec:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration,codec_name input.mp4
```

JSON output:

```bash
ffprobe -v error -print_format json -show_format -show_streams input.mp4
```

Duration only (seconds):

```bash
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4
```

## Trimming and cutting

Precise trim (re-encodes):

```bash
ffmpeg -hide_banner -y -i input.mp4 -ss 00:00:10 -t 00:00:30 output.mp4
```

Fast trim (stream copy, may be slightly imprecise on keyframes):

```bash
ffmpeg -hide_banner -y -ss 00:00:10 -i input.mp4 -t 00:00:30 -c copy output.mp4
```

Remove a middle section (keep 0-10s and 20s-end):

```bash
ffmpeg -hide_banner -y -i input.mp4 -filter_complex \
  "[0:v]trim=0:10,setpts=PTS-STARTPTS[v1]; \
   [0:a]atrim=0:10,asetpts=PTS-STARTPTS[a1]; \
   [0:v]trim=20,setpts=PTS-STARTPTS[v2]; \
   [0:a]atrim=20,asetpts=PTS-STARTPTS[a2]; \
   [v1][a1][v2][a2]concat=n=2:v=1:a=1[vout][aout]" \
  -map "[vout]" -map "[aout]" output.mp4
```

## Concatenation

Same codec (no re-encode):

```bash
printf "file '%s'\n" video1.mp4 video2.mp4 video3.mp4 > /tmp/concat-list.txt
ffmpeg -hide_banner -y -f concat -safe 0 -i /tmp/concat-list.txt -c copy output.mp4
```

Different formats (re-encodes):

```bash
ffmpeg -hide_banner -y -i video1.mp4 -i video2.mov \
  -filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[vout][aout]" \
  -map "[vout]" -map "[aout]" output.mp4
```

## Format conversion

MOV to MP4:

```bash
ffmpeg -hide_banner -y -i input.mov -c:v libx264 -crf 23 -c:a aac output.mp4
```

MP4 to WebM:

```bash
ffmpeg -hide_banner -y -i input.mp4 -c:v libvpx-vp9 -crf 30 -b:v 0 -c:a libopus output.webm
```

Video to GIF:

```bash
ffmpeg -hide_banner -y -i input.mp4 -vf "fps=10,scale=320:-1:flags=lanczos" output.gif
```

High-quality GIF (two-pass with palette):

```bash
ffmpeg -hide_banner -y -i input.mp4 -vf "fps=10,scale=320:-1:flags=lanczos,palettegen" /tmp/palette.png
ffmpeg -hide_banner -y -i input.mp4 -i /tmp/palette.png \
  -filter_complex "fps=10,scale=320:-1:flags=lanczos[x];[x][1:v]paletteuse" output.gif
```

## Video filters

Scale / resize:

```bash
ffmpeg -hide_banner -y -i input.mp4 -vf "scale=1280:720" output.mp4
ffmpeg -hide_banner -y -i input.mp4 -vf "scale=-1:720" output.mp4   # preserve aspect
```

Crop:

```bash
ffmpeg -hide_banner -y -i input.mp4 -vf "crop=640:480:0:0" output.mp4
```

Rotate:

```bash
ffmpeg -hide_banner -y -i input.mp4 -vf "transpose=1" output.mp4   # 90 clockwise
ffmpeg -hide_banner -y -i input.mp4 -vf "transpose=2" output.mp4   # 90 counter-clockwise
```

Speed change:

```bash
ffmpeg -hide_banner -y -i input.mp4 -vf "setpts=0.5*PTS" -af "atempo=2.0" output.mp4   # 2x
ffmpeg -hide_banner -y -i input.mp4 -vf "setpts=2.0*PTS" -af "atempo=0.5" output.mp4   # 0.5x
```

Text overlay:

```bash
ffmpeg -hide_banner -y -i input.mp4 \
  -vf "drawtext=text='Hello':fontsize=24:fontcolor=white:x=10:y=10" output.mp4
```

## Audio operations

Extract audio:

```bash
ffmpeg -hide_banner -y -i input.mp4 -vn -c:a copy output.m4a
ffmpeg -hide_banner -y -i input.mp4 -vn -c:a libmp3lame -q:a 2 output.mp3
```

Replace audio track:

```bash
ffmpeg -hide_banner -y -i video.mp4 -i audio.mp3 -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 output.mp4
```

Remove audio:

```bash
ffmpeg -hide_banner -y -i input.mp4 -an -c:v copy output.mp4
```

Adjust volume:

```bash
ffmpeg -hide_banner -y -i input.mp4 -af "volume=2.0" output.mp4
```

Fade in/out:

```bash
ffmpeg -hide_banner -y -i input.mp4 -af "afade=t=in:st=0:d=3,afade=t=out:st=27:d=3" output.mp4
```

## Advanced

Change framerate:

```bash
ffmpeg -hide_banner -y -i input.mp4 -r 30 output.mp4
```

Image sequence to video:

```bash
ffmpeg -hide_banner -y -framerate 30 -pattern_type glob -i '*.png' -c:v libx264 -pix_fmt yuv420p output.mp4
```

Picture-in-picture:

```bash
ffmpeg -hide_banner -y -i main.mp4 -i overlay.mp4 \
  -filter_complex "[1:v]scale=320:240[pip];[0:v][pip]overlay=10:10" output.mp4
```

Side-by-side:

```bash
ffmpeg -hide_banner -y -i left.mp4 -i right.mp4 -filter_complex "[0:v][1:v]hstack=inputs=2" output.mp4
```

## Common options

- `-i file` — input file
- `-c copy` — stream copy (no re-encode, fast)
- `-c:v codec` — video codec (`libx264`, `libx265`, `libvpx-vp9`)
- `-c:a codec` — audio codec (`aac`, `libmp3lame`, `libopus`)
- `-crf N` — quality (lower = better; 18-28 typical)
- `-b:v 1M` — video bitrate
- `-r N` — framerate
- `-vf "filter"` — video filter
- `-af "filter"` — audio filter
- `-ss HH:MM:SS` — start time
- `-t duration` — duration
- `-to HH:MM:SS` — end time
- `-an` — strip audio
- `-vn` — strip video
- `-y` — overwrite without asking
- `-hide_banner` — suppress build info
- `-loglevel error` — errors only

## Tips

- Always inspect with `ffprobe` before editing.
- Use `-c copy` when possible to avoid slow re-encoding.
- Place `-ss` before `-i` for fast seek (stream copy); after `-i` for precise seek (re-encode).
- Test complex filter chains on short clips first.
- Use `-hide_banner -loglevel error` for cleaner output.
- For speed changes with audio, pair `-vf setpts` with `-af atempo`.
