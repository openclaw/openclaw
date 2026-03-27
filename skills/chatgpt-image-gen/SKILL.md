---
name: chatgpt-image-gen
description: Generate images via ChatGPT web UI (DALL-E, uses browser automation on Windows).
---

# ChatGPT Image Generation (Browser)

Generate images using ChatGPT's web UI (DALL-E) via patchright browser automation on Windows.
Uses your logged-in ChatGPT session — free tier or Plus.

## Prerequisites

- Windows machine with Node.js and `C:\mickey-browser` setup
- patchright installed: `cd C:\mickey-browser && npm install`
- Logged in to ChatGPT: `node C:\mickey-browser\chatgpt-image-gen.js --login`

## First-time login

```powershell
cd C:\mickey-browser
node chatgpt-image-gen.js --login
```

Browser opens, log in to ChatGPT, then press Enter in terminal. Cookies saved to `chatgpt-cookies.json`.

## Generate image

From Linux (WSL):

```bash
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "Set-Location C:\mickey-browser; node chatgpt-image-gen.js --prompt 'your image description' --output output.jpg"
```

From PowerShell:

```powershell
cd C:\mickey-browser
node chatgpt-image-gen.js --prompt "your image description" --output output.jpg
```

## Notes

- DALL-E generation can take 30-90 seconds.
- Free tier has limited image generations per day.
- The script prints `MEDIA:<path>` for OpenClaw auto-attachment.
- Cookies may expire — re-run `--login` if you get login errors.
- Do not read the image back; report the saved path only.
