# Plan: Add ffmpeg CLI Skill

## Context

The OpenClaw project integrates CLI tools as **skills** — markdown files (`SKILL.md`) with YAML frontmatter that teach the agent how to use CLI commands via the existing `exec` tool. Examples include `sonoscli` (Sonos speakers), `openhue` (Philips Hue lights), and `spotify-player`.

There is an existing `video-frames` skill (`skills/video-frames/SKILL.md`) that uses ffmpeg, but it only extracts single frames via a wrapper shell script. There is no skill for general-purpose video/audio editing with ffmpeg.

**Goal**: Add a comprehensive `ffmpeg` skill so the agent can perform video and audio editing tasks — trimming, concatenation, format conversion, filters, audio extraction, GIF creation, and more — using the same skill pattern as Sonos and Hue.

## Approach

Create a new `skills/ffmpeg/SKILL.md` as a separate skill, keeping `video-frames` unchanged. No TypeScript code changes needed — this is purely a skill definition (markdown + frontmatter). The agent will invoke ffmpeg/ffprobe directly via the `exec` tool, guided by the SKILL.md instructions.

## Files Created

### 1. `skills/ffmpeg/SKILL.md`

**Frontmatter** (follows exact pattern from `skills/sonoscli/SKILL.md` and `skills/openhue/SKILL.md`):

- `name`: `ffmpeg`
- `description`: Short summary of capabilities
- `homepage`: `https://ffmpeg.org`
- `metadata.openclaw.emoji`: `"🎬"`
- `metadata.openclaw.requires.bins`: `["ffmpeg", "ffprobe"]`
- `metadata.openclaw.install`: brew formula `"ffmpeg"` (installs both binaries)

**Content sections** (teach the agent direct ffmpeg/ffprobe commands, no wrapper scripts):

1. **Quick Start** — inspect, convert, trim (3 examples)
2. **Media Inspection (ffprobe)** — get duration/resolution/codec, JSON output, specific fields
3. **Trimming & Cutting** — precise vs fast trim, removing middle sections
4. **Concatenation** — same-codec concat (file list + `-c copy`), mixed-format concat (filter_complex)
5. **Format Conversion** — MP4/WebM/MOV conversions, video-to-GIF (basic + palette method)
6. **Video Filters** — scale, crop, rotate, speed change, text overlay
7. **Audio Operations** — extract, replace, remove, volume adjust, fade in/out
8. **Advanced** — framerate change, image sequence to video, picture-in-picture, side-by-side
9. **Common Options Reference** — table of frequently-used flags (`-i`, `-c copy`, `-crf`, `-ss`, `-t`, `-vf`, `-af`, `-y`, etc.)
10. **Tips** — inspect first, use `-c copy` when possible, test on short clips, use `-hide_banner -loglevel error`

### 2. `plans/ffmpeg-skill.md`

This plan document saved to the project root `/plans/` folder.

## Files NOT Modified

- `skills/video-frames/SKILL.md` — remains as-is (narrow frame extraction skill)
- No TypeScript source files — skills are purely markdown
- No config schema changes — skill discovery is automatic

## Verification

1. **Skill loads correctly**: Run `openclaw` and verify the ffmpeg skill appears in the available skills list (requires `ffmpeg` and `ffprobe` on PATH)
2. **Agent uses the skill**: Ask the agent "trim the first 30 seconds from video.mp4" and confirm it reads the SKILL.md and constructs correct ffmpeg commands
3. **Frontmatter parses**: Verify the YAML frontmatter matches the schema used by existing skills (compare with `skills/sonoscli/SKILL.md`)
4. **Binary check works**: Remove ffmpeg from PATH temporarily and verify the skill is filtered out
