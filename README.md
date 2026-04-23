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
  
## Platform summary
  
| Platform | Images | Audio | Video | Social Embeds |
| -------- | ------ | ----- | ----- | ------------- |
| WebChat  | ✅     | ✅    | ✅    | ✅            |
| Telegram | ✅     | ❌    | ❌    | ❌            |
  
## Extra features
  
- Added resize handles on webchat messages so you can resize media!
- Added audio/video memory playback. Close or refresh the browser, it remembers where you stopped.
- Added new core tool for downloading YouTube and other video's called download_video using yt-dlp
- UI changes to get rid of most of the dead screen space.  Larger area now for messages.

## Implementation details
  
- Local HTTP media server (port 18791) for WebChat streaming of local files.
- Extension-based MIME mapping for audio/video
- MIME detection for images
- Social media URL pattern matching
  
## Breaking changes
  
None - all features are additive.
  
## Some Screenshots

<img width="1462" height="948" alt="Screenshot 2026-04-23 112822" src="https://github.com/user-attachments/assets/68e66bfa-8539-4dbb-af2a-f38d147da05b" /><br>

<img width="1464" height="948" alt="Screenshot 2026-04-23 164707" src="https://github.com/user-attachments/assets/479bb1a0-ba4a-478b-a31d-16cec27f5589" /><br>

<img width="1462" height="949" alt="Screenshot 2026-04-23 164739" src="https://github.com/user-attachments/assets/e645089d-b1fb-43df-8e93-d9fbab41e318" /><br>
  
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

To build and install globally (Skipping all the below steps), simply run from root folder: ./global 

OR

```bash
git clone https://github.com/jdc4429/openclaw.git
cd openclaw

pnpm install

# First run only (or after resetting local OpenClaw config/workspace)
pnpm openclaw setup

pnpm ui:build

# Dev loop (auto-reload on source/config changes)
pnpm gateway:watch

pnpm build
```

`pnpm openclaw setup` writes the local config/workspace needed for `pnpm gateway:watch`. It is safe to re-run, but you normally only need it on first setup or after resetting local state. `pnpm gateway:watch` does not rebuild `dist/control-ui`, so rerun `pnpm ui:build` after `ui/` changes or use `pnpm ui:dev` when iterating on the Control UI. If you want this checkout to run onboarding directly, use `pnpm openclaw onboard --install-daemon`.
  
Note: You still need to install the configuration portion in a user folder ie. /home/openclaw<br>
  
I created a copy with an example config you can simple download and 'tar xzvf file.tgz ~/' to extract to your current user folder.<br>
Edit openclaw.json config to add your API keys, change root folders, and run setup for some extra plugins.<br>



