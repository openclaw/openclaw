---
name: gemini-image-gen
description: Generate images via Gemini web UI (Imagen, uses browser automation on Windows).
---

# Gemini Image Generation (Browser)

Generate images using Gemini's web UI (Imagen) via patchright browser automation on Windows.
Uses your logged-in Google account — free.

## Prerequisites

- Windows machine with Node.js and `C:\mickey-browser` setup
- patchright installed: `cd C:\mickey-browser && npm install`
- Logged in to Gemini: `node C:\mickey-browser\gemini-image-gen.js --login`

## First-time login

```powershell
cd C:\mickey-browser
node gemini-image-gen.js --login
```

Browser opens, log in with your Google account, then press Enter in terminal. Cookies saved to `gemini-cookies.json`.

## Generate image

From Linux (WSL):

```bash
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "Set-Location C:\mickey-browser; node gemini-image-gen.js --prompt 'your image description' --output output.jpg"
```

From PowerShell:

```powershell
cd C:\mickey-browser
node gemini-image-gen.js --prompt "your image description" --output output.jpg
```

## Notes

- Uses Gemini's web Imagen model (not the API — no API key or quota needed).
- The script prints `MEDIA:<path>` for OpenClaw auto-attachment.
- Cookies may expire — re-run `--login` if you get login errors.
- Do not read the image back; report the saved path only.
