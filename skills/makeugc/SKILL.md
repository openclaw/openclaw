---
name: makeugc
description: Generate UGC-style videos using AI Avatars (via HeyGen API).
homepage: https://docs.heygen.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🎭",
        "requires": { "bins": ["node"], "env": ["HEYGEN_API_KEY"] },
        "primaryEnv": "HEYGEN_API_KEY",
        "install":
          [
            {
              "id": "node",
              "kind": "brew",
              "formula": "node",
              "bins": ["node"],
              "label": "Install Node.js",
            },
          ],
      },
  }
---

# MakeUGC (HeyGen)

Generate realistic UGC-style videos with AI Avatars from text scripts.

## Setup

1.  Get an API Key from [HeyGen](https://heygen.com).
2.  Set `HEYGEN_API_KEY` in your `.env` file.

## Usage

### Generate a Video

```bash
# Basic usage
node {baseDir}/scripts/generate.js --prompt "Create a 15s ad for organic coffee" --out video.mp4

# Advanced
node {baseDir}/scripts/generate.js --prompt "SaaS testimonial" --avatar "josh_lite3_20230714" --background "#00FF00"
```

### Dry Run (Script Generation Only)

Test the script writing capabilities without burning API credits:

```bash
node {baseDir}/scripts/generate.js --prompt "Test prompt" --dry-run
```
