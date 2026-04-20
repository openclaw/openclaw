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

<img width="1446" height="953" alt="Rocky-Mountaineer-screenshot-small" src="https://github.com/user-attachments/assets/7f49f842-af5b-45fd-8fd3-30e6c79c2bb4" /><br>
  
<img width="1449" height="956" alt="Rocky-Mountaineer-screenshot" src="https://github.com/user-attachments/assets/f6ab3c5b-5d13-4ac8-81c5-a160cf589c2a" /><br>
  
<img width="1250" height="894" alt="embeded-video" src="https://github.com/user-attachments/assets/f0eba12d-4406-41a4-b374-6868e681a898" /><br>  
    
<img width="1627" height="1078" alt="media-server" src="https://github.com/user-attachments/assets/42f464e9-2b48-4e89-a3fd-e743b01124fa" /><br>  
  
https://github.com/user-attachments/assets/a11f41b2-0262-48c7-8ba2-7c5462840d6f  
  

  
## Examples
  
See TOOLS-EXAMPLE.md  
See openclaw-EXAMPLE.json  

