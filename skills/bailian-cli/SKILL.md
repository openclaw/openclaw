---
name: bailian-cli
description: "Alibaba Cloud Model Studio CLI (`bl`) for AI generation: text chat, image generate/edit, video generate/edit, multimodal, vision, TTS/ASR, web search, memory, knowledge RAG, app call."
homepage: https://bailian.console.aliyun.com/cli
metadata:
  {
    "openclaw":
      {
        "emoji": "🤖",
        "requires": { "bins": ["bl"], "env": ["DASHSCOPE_API_KEY"] },
        "primaryEnv": "DASHSCOPE_API_KEY",
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "bailian-cli",
              "bins": ["bl"],
              "label": "Install Bailian CLI (npm)",
            },
          ],
      },
  }
---

# Bailian CLI (`bl`)

Use the `bl` command when the user wants to generate or process AI content via Alibaba Cloud Model Studio (DashScope): text chat, image generation/editing, video generation/editing, multimodal understanding, vision, TTS, ASR, web search, memory, knowledge RAG, or app calling.

## Command reference (authoritative)

All commands, flags, usage strings, and examples are documented in:

- [`reference/index.md`](reference/index.md) — quick index, global flags, links by group
- [`reference/<group>.md`](reference/) — per top-level command (e.g. [`reference/video.md`](reference/video.md))

Before running an unfamiliar command:

1. Open `reference/index.md` → **Quick index** (or **By group**) to locate the command.
2. Open the matching `reference/<group>.md` for **Usage**, **Options**, and **Examples**.
3. Run `bl <command> --help` for the same information in the terminal.

Do not guess flags — use the reference files or `--help`.

---

## When to use which command

| User intent                                  | Command                            | Default model / notes                         |
| -------------------------------------------- | ---------------------------------- | --------------------------------------------- |
| Text, chat, code, translation                | `bl text chat`                     | `qwen3.6-plus`                                |
| Multimodal input + text/audio out            | `bl omni`                          | `qwen3.5-omni-plus`                           |
| Video/audio understanding (with audio reply) | `bl omni --video` / `--audio`      | Prefer over generic VL for A/V Q&A            |
| Image from text                              | `bl image generate`                | `qwen-image-2.0`                              |
| Image edit / multi-image merge               | `bl image edit` (repeat `--image`) | `qwen-image-2.0`                              |
| Video from text or image                     | `bl video generate`                | `happyhorse-1.0-t2v` / `-i2v` with `--image`  |
| Video edit / style transfer                  | `bl video edit`                    | `happyhorse-1.0-video-edit`                   |
| Reference-to-video + voice                   | `bl video ref`                     | `happyhorse-1.0-r2v`                          |
| Image / video describe (text only)           | `bl vision describe`               | `qwen-vl-max`                                 |
| TTS                                          | `bl speech synthesize`             | `cosyvoice-v3-flash`                          |
| ASR                                          | `bl speech recognize`              | `fun-asr`                                     |
| Web search                                   | `bl search web`                    | DashScope MCP search                          |
| Bailian agent / workflow                     | `bl app call`                      | Needs `--app-id`                              |
| Find app by name                             | `bl app list` then `bl app call`   | Console auth                                  |
| Memory CRUD / profile                        | `bl memory *`                      | [`reference/memory.md`](reference/memory.md)  |
| Knowledge RAG                                | `bl knowledge retrieve`            | RAM AK/SK + index ID                          |
| List foundation models                       | `bl model list`                    | Console auth; default output yaml             |
| Upload file to temp OSS                      | `bl file upload`                   | When you need `oss://` URL explicitly         |

---

## Local files

Any command that accepts a **file URL** also accepts a **local path**. The CLI uploads to DashScope temporary storage (`oss://`, 48h) automatically.

```bash
bl image edit --image ./photo.png --prompt "Add sunset"
bl video edit --video ./clip.mp4 --prompt "Anime style"
bl omni --message "What do you see?" --image ./photo.jpg --audio ./voice.wav
bl speech recognize --url ./meeting.wav
bl vision describe --image ./screenshot.png
```

If the user gives a local file, pass the path directly. Do not ask them to upload or host a URL.

---

## Installation and authentication

```bash
npm install -g bailian-cli
```

| Auth          | How                                                                   | Used by                                                |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| API key       | `export DASHSCOPE_API_KEY=sk-...` or `bl auth login --api-key sk-...` | Most DashScope API commands                            |
| Console token | `bl auth login --console`                                             | `app list`, `model list`, `usage free`, `console call` |

```bash
bl auth status          # check current auth
bl auth logout          # clear credentials
```

Get an API key: https://bailian.console.aliyun.com/cn-beijing/?tab=app#/api-key

**Region:** `cn` (default), `us`, `intl` — set via `--region` or `DASHSCOPE_REGION` or `bl config set --key region --value us`.

---

## Quick examples

```bash
# Chat
bl text chat --message "Explain quantum computing in simple terms"

# Image
bl image generate --prompt "A cat in space" --out-dir ./out/

# Video (wait for task, save file)
bl video generate --prompt "Sunset on the beach" --download sunset.mp4

# Omni multimodal (local files OK)
bl omni --message "Describe this video" --video ./demo.mp4 --text-only

# TTS
bl speech synthesize --text "Hello world" --voice Cherry --out hello.wav

# ASR
bl speech recognize --url ./meeting.wav

# Web search
bl search web --query "latest AI news"

# App
bl app list --output json
bl app call --app-id <code> --prompt "Hello"
```

More examples per command: see `reference/<group>.md`.

---

## Notes

- Video commands produce short clips (about 2-10s). For concatenation or mixing audio, use **ffmpeg** after generating clips.
- Console commands (`app list`, `model list`, `usage free`, `console call`) require `bl auth login --console`.
- Most API commands use `DASHSCOPE_API_KEY` or `bl auth login --api-key`.
- Default output: **text** in TTY; **json** when piped. Console list commands default to **yaml** unless `--output` is set.
