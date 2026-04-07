AGENTS.md

# OpenClaw KASAI Edition - Project Context

## Identity
This is the KASAI edition of OpenClaw, Sean Uddin's customized fork.
Owner: Sean Uddin (Somo Kasane), PT Metafintek AI Studios, Lombok, Indonesia.

## LLM Backend: LM Studio (Local)
All models run locally via LM Studio at `http://127.0.0.1:1234/v1`.
Config: `~/.openclaw/openclaw.json`
Provider ID: `lmstudio`
API mode: `openai-completions`

### Available Models (all zero-cost, local)
| Alias       | Model ID                        | Params   | Capabilities         | Context  |
|-------------|--------------------------------|----------|---------------------|----------|
| Qwen 9B    | qwen/qwen3.5-9b               | 9B       | Text, coding        | 64K      |
| Gemma      | google/gemma-4-26b-a4b         | 26B MoE  | Text, audio transcription | 4K |
| Bonsai     | bonsai-8b                      | 8.2B     | Text                | 8K       |
| Qwen VL 8B | qwen/qwen3-vl-8b             | 8B       | Text, vision        | 32K      |
| Qwen VL 4B | qwen/qwen3-vl-4b             | 4B       | Text, vision        | 32K      |
| Nemotron   | nvidia/nemotron-3-nano-4b      | 4B       | Text                | 8K       |
| Qwen VL 30B| qwen/qwen3-vl-30b            | 30B MoE  | Text, vision        | 32K      |
| GLM Flash  | zai-org/glm-4.7-flash         | 30B      | Text                | 32K      |

### Default Primary Model
`lmstudio/qwen/qwen3.5-9b` (alias: "Qwen 9B")
Switch models in TUI: `/model gemma`, `/model qwen vl 8b`, etc.

### Model Selection Strategy
- Qwen 3.5 9B: default execution layer, best balance of speed and capability
- Gemma 4 26B-A4B: audio transcription, larger reasoning tasks
- Qwen VL variants: anything involving images or screenshots
- Nemotron Nano: fastest responses, simple tasks
- GLM Flash: alternative general-purpose

## Tools

### YouTube Downloader (yt-grab)
Path: `C:\Users\MAG MSI\Project Claude\Youtube Downloader\yt-grab.py`
Also in repo: `tools/yt-grab.py`
Depends on: `yt-dlp` (installed), `ffmpeg` (for audio conversion)

Usage via execute tool:
```
# Rip full video
python "C:/Users/MAG MSI/Project Claude/Youtube Downloader/yt-grab.py" "URL"

# Rip audio only (MP3)
python "C:/Users/MAG MSI/Project Claude/Youtube Downloader/yt-grab.py" "URL" --audio-only

# Rip audio for transcription (16kHz mono WAV, optimal for Gemma)
python "C:/Users/MAG MSI/Project Claude/Youtube Downloader/yt-grab.py" "URL" --transcript

# Get video info without downloading
python "C:/Users/MAG MSI/Project Claude/Youtube Downloader/yt-grab.py" "URL" --info

# Download playlist
python "C:/Users/MAG MSI/Project Claude/Youtube Downloader/yt-grab.py" "PLAYLIST_URL" --playlist --audio-only
```

### Web Search
Provider: DuckDuckGo (bundled plugin, enabled)
All models get internet access through OpenClaw's web_search and web_fetch tools.

## Local Project Paths (C:\Users\MAG MSI)
All accessible via execute/read/write tools (fs.workspaceOnly is false).

| Project           | Path                                              | Notes                              |
|-------------------|---------------------------------------------------|------------------------------------|
| Strands           | C:\Users\MAG MSI\Project Strands                  | Primary project, context in CONTEXT.md |
| OpenClaw Kasai    | C:\Users\MAG MSI\clawdbot-KASAI-edition-          | This repo                          |
| Claude Tools      | C:\Users\MAG MSI\Project Claude                   | YouTube downloader, skills, utils  |
| Melkor            | C:\Users\MAG MSI\Project Melkor                   | 256 Wellness Lite                  |
| ComfyUI           | C:\Users\MAG MSI\Project ComfyUI                  | Local ComfyUI (see also G:\Project Comfy) |
| Fintrek Trader    | C:\Users\MAG MSI\Project Fintrek Trader           | Trading project                    |
| Gstack            | C:\Users\MAG MSI\Project Gstack                   | Stack project                      |
| Muse              | C:\Users\MAG MSI\Project Muse                     | Creative/generative                |
| Research          | C:\Users\MAG MSI\Project Research                 | Research materials                 |
| Ace               | C:\Users\MAG MSI\Project Ace                      | Ace project                        |
| Crucix            | C:\Users\MAG MSI\Project Crucix                   | Crucix project                     |
| Paperclip         | C:\Users\MAG MSI\Project Paperclip                | Paperclip project                  |
| Uddin             | C:\Users\MAG MSI\Project Uddin                    | Personal/entity docs               |

### External Drives (if mounted)
- ComfyUI assets: G:\Project Comfy
- LTX generation: G:\LTX

## Hardware
- GPU: RTX 5090, 32GB VRAM
- System RAM: 126 GB
- LM Studio memory usage varies by loaded model

## Gateway
- Mode: local
- Port: 18789
- Bind: loopback
- Auth: token-based

## Parent Project
Part of the Strands ecosystem (strandsnation.xyz).
Primary context file: `C:\Users\MAG MSI\Project Strands\CONTEXT.md`
