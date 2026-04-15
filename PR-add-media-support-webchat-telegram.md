## What does this PR do?

Adds comprehensive media support to OpenClaw across multiple channels:

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

## WebChat message resizing

Also added resize handles on webchat messages so you can resize media!

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

## Testing performed

- [x] All image formats (WebChat + Telegram)
- [x] All audio formats (WebChat)
- [x] All video formats (WebChat)
- [x] Social media embeds (WebChat)

## Breaking changes

None - all features are additive.

## Modifications to add image, audio, and video to webchat.

#Added & Modified Files:

.openclaw\workspace\openclaw\ui\src\styles\chat\grouped.css  
.openclaw\workspace\openclaw\ui\src\ui\chat\grouped-render.ts  
.openclaw\workspace\openclaw\src\gateway\control-ui-csp.ts  
.openclaw\workspace\openclaw\ui\src\ui\markdown.ts  
.openclaw\workspace\openclaw\src\agents\tools\download-video.ts  
.openclaw\workspace\openclaw\src\agents\pi-tools.ts  
.openclaw\workspace\openclaw\src\agents\pi-tools.read.ts  
.openclaw\workspace\openclaw\src\agents\image-sanitization.ts  
.openclaw\workspace\openclaw\src\agents\tool-media.ts  
.openclaw\workspace\openclaw\src\agents\tool-images.ts  
.openclaw\workspace\.openclaw-dev\src\agents\command\types.ts  
.openclaw\workspace\openclaw\src\gateway\chat.ts  
.openclaw\workspace\openclaw\src\agents\tools\image-tool.ts

## Some Screenshots

<img width="1250" height="894" alt="embeded-video" src="https://github.com/user-attachments/assets/f0eba12d-4406-41a4-b374-6868e681a898" />
  
<img width="1250" height="894" alt="Screenshot 2026-04-07 013354" src="https://github.com/user-attachments/assets/63de7368-2b85-4f58-9033-717de68af0bf" />
  
<img width="1408" height="950" alt="Screenshot 2026-04-07 094253" src="https://github.com/user-attachments/assets/84af6222-9d08-44fb-8d60-3dfd8ef8a528" />

https://github.com/user-attachments/assets/a11f41b2-0262-48c7-8ba2-7c5462840d6f


  
## Example TOOLS.md
  
# TOOLS.md - Local Environment Manifest
  
## 1. Media Server (Local File Audio/Video Streaming)
  
- **Server URL:** `http://localhost:18791`
- **Status Check:** If media server not responding, start with:

```bash
python3 /home/openclaw/.openclaw/workspace/media-server.py --port 18791 --max-depth 2
```

- Supported Audio Formats: MP3, WAV, OGG, FLAC, M4A, AAC, OPUS, WMA
- Supported Video Formats: MP4, WEBM, MKV, AVI, MOV, M4V, MPG, MPEG
- Streaming URLs: Return http://localhost:18791/filename.extension for playback
- No size limits - streams directly, no base64 embedding for audio or video. Just images.

## 2. Media Sanitization Bypass (tool-media.ts)

- **Purpose:** Prevents audio/video content from being stripped or converted by the image sanitizer
- **Behavior:** Detects blocks with type "audio" or "video" and returns them untouched
- **Why it exists:** The image sanitizer would otherwise convert audio/video to AVIF images
- **Status:** Active - audio/video blocks pass through unchanged

## 3. Web Search vs Web Fetch

**web_search** - Use this for finding information, searching the web, looking up current events, finding links. This uses DuckDuckGo/Brave API and is safe.
**web_fetch** - ONLY use this when the user provides a SPECIFIC URL they want to fetch. Never use web_fetch for general searches.

When a user asks to "search for" something, ALWAYS use web_search, NOT web_fetch.

## 4. File Reading Tool

- **Command:** `read <filename>`
- Text files: Returns content directly
- Image files: Returns base64 data URL for display up to 4K
- Audio/Video files: Returns streaming URL (no raw data, no size limits)
- Path resolution: All paths are absolute

## 5. Port Assignments

- OpenClaw Production Gateway Port: 18789
- OpenClaw Development Gateway Port: 18790
- OpenClaw Media Server Port: 18791

## 6. Response Guidelines

- For media files: Return `http://localhost:18791/filename.extension`
- For YouTube/Vimeo links: Return embed URL, not the watch URL
- For tool usage: Use tools rather than guessing
- Keep responses concise but with personality
- When unsure about hardware: Reference this file

## 7. Video Download Tool

**Tool name:** `download_video` (underscore, not hyphen)

**Usage:** When user says:\*\* "download", "save", "get this video", "keep this video" - USE download_video tool
download_video url: "VIDEO_URL"

**Example:**
download_video url: "https://www.youtube.com/watch?v=nVuTAb0pUBU"
download_video url: "https://www.youtube.com/watch?v=VIDEO_ID" quality: "best"

**Purpose:** Download videos from YouTube, Vimeo, Twitch, Dailymotion, etc. directly to the workspace

\*\*CRITICAL: Do NOT add any commentary or describe the download location. The tool already embeds the video player and downloads the file.

**How it works:**

- Automatically installs yt-dlp (first run) to `~/.openclaw/bin/`
- Automatically installs ffmpeg (first run) on Linux (required for merging video/audio)
- Downloads video to `~/.openclaw/workspace/`
- Returns an HTML5 video player in chat for immediate playback

**Quality Options:**

- `best` - Highest quality available
- `best[height<=720]` - 720p max (default, balances quality/size)
- `worst` - Lowest quality (fastest download)

**Note:** First run may take extra time to install dependencies (requires sudo for ffmpeg on Linux). Downloaded videos are served via media server at `http://localhost:18791/filename.mp4`

**When NOT to use:**

- User just wants to watch a video (use video embedding instead)
- User only asked to "watch" not "download"

## 8. Media Server Management

**Purpose:** Serves audio/video files from workspace to webchat

**URL:** `http://localhost:18791`

**If media server is not responding:**

1. Check if running: `ps aux | grep media-server.py`
2. Start manually: `python3 /home/openclaw/.openclaw/workspace/media-server.py --port 18791 --max-depth 2`

**What it serves:**

- Audio files (MP3, WAV, OGG, FLAC, M4A, AAC, OPUS, WMA)
- Video files (MP4, WEBM, MKV, AVI, MOV, M4V, MPG, MPEG)
- Downloaded videos (via download_video tool)

**Note:** The media server runs in the background. You don't need to interact with it directly - just use `http://localhost:18791/filename.extension` URLs.

## 9. Ollama Vision Model Usage

**Model:** `qwen3-vl:2b` (local Ollama vision model)

**When to use:** When analyzing images with local vision capabilities instead of cloud services

**Direct command syntax:**

```bash
ollama run qwen3-vl:2b "Describe this image" -- /path/to/image.jpg
```

**Example workflow:**

1. Find image path: `find /home/openclaw/.openclaw -name "*.jpg"`
2. Run vision analysis: `ollama run qwen3-vl:2b "Describe what you see" -- /path/to/image.jpg`
3. Monitor with process tool if command runs in background

## 10. Image Upload Handling in Webchat

**How webchat images work:**

- Images uploaded via webchat are converted to base64 data URLs
- Sent via `chat.send()` with attachment object: `{ type: "image", mimeType, content }`
- Gateway parses attachment and passes as vision content block to model API

**File path availability:**

- Telegram/WhatsApp: Images saved to `~/.openclaw/media/inbound/<uuid>.<ext>`
- Webchat: Images remain ephemeral base64 - no file path accessible

**Key implications:**

- Webchat uploads cannot be accessed via file path tools

---

Use this file to resolve ambiguous requests regarding network setup, media playback, or preferred output styles.
When a user asks to "watch" something, default to video embedding.
