# 🦞 OpenClaw — Personal AI Assistant
  
This custom build adds comprehensive media support to OpenClaw across multiple channels:
  
### 🌐 WebChat (Complete media suite)
  
**Previously had NO media support - now fully featured:**
  
**Images:**
  
- JPEG/JPG
- PNG
- GIF
- WebP
- SVG
- BMP

**Audio (local files - streamed via HTTP server on port 18791):**

- OGG (.ogg) - audio/ogg
- MP3 (.mp3) - audio/mpeg
- WAV (.wav) - audio/wav
- FLAC (.flac) - audio/flac
- M4A (.m4a) - audio/mp4
- AAC (.aac) - audio/aac
- Opus (.opus) - audio/opus
- WebM audio (.webm) - audio/webm
- WMA (.wma) - audio/x-ms-wma

**Video (local files - streamed via HTTP server on port 18791):**

- MP4 (.mp4) - video/mp4
- WebM (.webm) - video/webm
- AVI (.avi) - video/x-msvideo
- MOV (.mov) - video/quicktime
- MKV (.mkv) - video/x-matroska
- M4V (.m4v) - video/x-m4v
- MPG/MPEG (.mpg, .mpeg) - video/mpeg

**Social Media Embeds:**

- YouTube
- Twitter/X
- TikTok
- Instagram
- (Other platforms via URL detection)

## 📱 Telegram

**Images:**

- JPEG/JPG
- PNG
- GIF
- WebP
- SVG
- BMP
  
## Extra features
  
- Added resize handles on webchat messages so you can resize media!
- Added audio/video memory playback. Close or refresh the browser, it remembers where you stopped.
- Added new core tool for downloading YouTube and other video's called download_video using yt-dlp

## Platform summary

| Platform | Images | Audio | Video | Social Embeds |
| -------- | ------ | ----- | ----- | ------------- |
| WebChat  | ✅     | ✅    | ✅    | ✅            |
| Telegram | ✅     | ❌    | ❌    | ❌            |

## Implementation details

- Local HTTP media server (port 18791) for WebChat streaming of local files.
- Extension-based MIME mapping for audio/video
- MIME detection for images
- Social media URL pattern matching

## Breaking changes

None - all features are additive.

## Some Screenshots

<img width="1446" height="953" alt="Rocky-Mountaineer-screenshot-small" src="https://github.com/user-attachments/assets/7f49f842-af5b-45fd-8fd3-30e6c79c2bb4" /><br>
  
<img width="1449" height="956" alt="Rocky-Mountaineer-screenshot" src="https://github.com/user-attachments/assets/f6ab3c5b-5d13-4ac8-81c5-a160cf589c2a" /><br>
  
<img width="1250" height="894" alt="embeded-video" src="https://github.com/user-attachments/assets/f0eba12d-4406-41a4-b374-6868e681a898" /><br>  
    
<img width="1627" height="1078" alt="media-server" src="https://github.com/user-attachments/assets/42f464e9-2b48-4e89-a3fd-e743b01124fa" /><br>  
  
https://github.com/user-attachments/assets/a11f41b2-0262-48c7-8ba2-7c5462840d6f  
  

## Examples
  
See TOOLS-EXAMPLE.md  
See openclaw-EXAMPLE.json  
<br><br><br><br>

# 🦞 OpenClaw — Personal AI Assistant

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.svg">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.svg" alt="OpenClaw" width="500">
    </picture>
</p>

## Install

I recommend you install globally and then have your config in a user folder like /home/openclaw

```bash
git clone https://github.com/jdc4429/openclaw/tree/jdc4429-custom-build
cd openclaw

pnpm install

# First run only (or after resetting local OpenClaw config/workspace)
pnpm openclaw setup

# Optional: prebuild Control UI before first startup
pnpm ui:build

# Dev loop (auto-reload on source/config changes)
pnpm gateway:watch
```

If you need a built `dist/` from the checkout (for Node, packaging, or release validation), run:

```bash
pnpm build
pnpm ui:build
```

`pnpm openclaw setup` writes the local config/workspace needed for `pnpm gateway:watch`. It is safe to re-run, but you normally only need it on first setup or after resetting local state. `pnpm gateway:watch` does not rebuild `dist/control-ui`, so rerun `pnpm ui:build` after `ui/` changes or use `pnpm ui:dev` when iterating on the Control UI. If you want this checkout to run onboarding directly, use `pnpm openclaw onboard --install-daemon`.

Note: `pnpm openclaw ...` runs TypeScript directly (via `tsx`). `pnpm build` produces `dist/` for running via Node / the packaged `openclaw` binary, while `pnpm gateway:watch` rebuilds the runtime on demand during the dev loop.





