---
name: grok-image-gen
description: Generate images via Grok web UI (free, uses browser automation on Windows).
---

# Grok Image Generation (Browser)

Generate images using Grok's web UI via patchright browser automation on Windows.
Free, no API key required — uses your logged-in Grok session.

## Prerequisites

- Windows machine with Node.js and `C:\mickey-browser` setup
- patchright installed: `cd C:\mickey-browser && npm install`
- Logged in to Grok: `node C:\mickey-browser\grok-image-gen.js --login`

## First-time login

```powershell
cd C:\mickey-browser
node grok-image-gen.js --login
```

Browser opens, log in to Grok, then press Enter in terminal. Cookies are saved to `grok-cookies.json`.

## Generate image

From Linux (WSL), run via PowerShell:

```bash
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "Set-Location C:\mickey-browser; node grok-image-gen.js --prompt 'your image description' --output output.jpg"
```

Or from PowerShell directly:

```powershell
cd C:\mickey-browser
node grok-image-gen.js --prompt "your image description" --output output.jpg
```

## Output

- The script prints `MEDIA:<path>` for OpenClaw auto-attachment.
- Images are downloaded via browser fetch (bypasses CDN auth).
- Typical output: 784x1168 JPEG, ~200KB.

## Notes

- Grok generates images for free (no API key, no quota limits).
- Uses patchright (anti-detection Playwright fork) to avoid bot detection.
- Cookies may expire — re-run `--login` if you get login errors.
- Do not read the image back; report the saved path only.
