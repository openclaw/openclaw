# TOOLS.md - Local Environment Manifest

## 1. Media Server (Local Audio/Video Streaming)
- **Server URL:** `http://localhost:18791`
- **Status Check:** If media server not responding, start with:
```bash
python3 workspace/media-server.py --port 18791 --max-depth 2
```
- Supported Audio Formats: MP3, WAV, OGG, FLAC, M4A, AAC, OPUS, WMA
- Supported Video Formats: MP4, WEBM, MKV, AVI, MOV, M4V, MPG, MPEG
- Streaming URLs: Return http://localhost:18791/path/to/filename.extension for playback

**Purpose:** Serves audio/video files from workspace to webchat
**Auto-start:** The media server currently does not start automatically. But the user probably started.

## 2. Web Search vs Web Fetch

**web_search** - Use this for finding information, searching the web, looking up current events, finding links. This uses DuckDuckGo/Brave API and is safe.
**web_fetch** - ONLY use this when the user provides a SPECIFIC URL they want to fetch. Never use web_fetch for general searches.

When a user asks to "search for" something, ALWAYS use web_search, NOT web_fetch.

## 3. File Reading Tool

- **Command:** `read <filename>`
- Text files: Returns content directly
- Image files: Returns base64 data URL that is displayed up to 4K
- Audio/Video files: Returns streaming URL to media server (no raw data, no size limits)
- STOP TALKING AND SHUT UP!!! The command already has all the output needed! DO NOT SAY ANYTHING ELSE!

## 4. Openclaw Port Assignments

- OpenClaw Production Gateway Port: 18789
- OpenClaw Development Gateway Port: 18790
- OpenClaw Media Server Port: 18791

## 5. Response Guidelines

- For media files: Return `http://localhost:18791/path/to/filename.extension`
- For YouTube/Vimeo links: Return embed URL, not the watch URL
- For tool usage: Use tools rather than guessing
- Keep responses concise but with personality
- When unsure about hardware: Reference this file

## 6. Video Download Tool

**Tool name:** `download_video`
**Usage:** When user says:** "download", "save", "get this video", "keep this video" - USE download_video tool - download_video url: "VIDEO_URL"

**Example:**
download_video url: "https://www.youtube.com/watch?v=nVuTAb0pUBU"
download_video url: "https://www.youtube.com/watch?v=VIDEO_ID" quality: "best"

**Purpose:** Download videos from YouTube, Vimeo, Twitch, Dailymotion, etc. directly to the workspace
- Tell the user the details when download is completed. Ask if they want to watch it. use read to watch/display in webchat

**Quality Options:**
- `best` - Highest quality available
- `best[height<=720]` - 720p max (default, balances quality/size)
- `worst` - Lowest quality (fastest download)

**When NOT to use:** User just wants to 'watch' not 'download' a video (use video embedding instead with read command)

## 7. Ollama Vision Model Usage

**Model:** `qwen3-vl:2b` (local Ollama vision model)

**When to use:** When asked to examine, look, or analyze images
**To download ollama model:** exec ollama pull qwen3-vl:2b

**Command syntax:**
```bash
ollama run qwen3-vl:2b "Describe this image" -- /path/to/image.jpg
```

**Example workflow:**
1. Find image path: `find /path/to/.openclaw -name "*.jpg"`
2. Run vision analysis: `ollama run qwen3-vl:2b "Describe what you see" -- /path/to/image.jpg`
3. Monitor with process tool if command runs in background

## 8. Image Upload Handling in Webchat

**How webchat images work:**
- Images uploaded via webchat are converted to base64 data URLs
- Sent via `chat.send()` with attachment object: `{ type: "image", mimeType, content }`
- Gateway parses attachment and passes as vision content block to model API

**File path availability:**
- Telegram/WhatsApp: Images saved to `~/.openclaw/media/inbound/<uuid>.<ext>`
- Webchat: Images remain ephemeral base64 - no file path accessible

**Model requirements:**
- Active primary model must support vision natively
- If text-only model: images may be silently dropped with no warning
- OpenClaw skips [Image] summary block for vision-native models

**Key implications:**
- Webchat uploads cannot be accessed via file path tools

---
Use this file to resolve ambiguous requests regarding network setup, media playback, or preferred output styles. When a user asks to "watch" something, default to video embedding using the read command.
