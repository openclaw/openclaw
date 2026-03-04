# 2026-03-04 Free AI Skills Implementation - qwen3.5-9B Brain

## Overview

Implemented 4 free AI skills for autonomous voice/vision operation using qwen3.5-9B as the central brain.

## Architecture

```
User Voice → voicevox_stt → qwen3.5:9b → voicevox_tts → Voice Output
Camera     → camera_vision → qwen3.5:9b → voicevox_tts → Voice Output
```

## Skills Created

### 1. voicevox-tts (skills/voicevox-tts/)

- **Purpose**: Free Japanese TTS using VOICEVOX engine
- **Endpoint**: http://localhost:50021
- **Speaker**: Default ID 2 (ずんだもん)
- **Files**:
  - `SKILL.md` - Documentation
  - `tts.py` - Python CLI tool
  - `tool.json` - Tool schema

### 2. voicevox-stt (skills/voicevox-stt/)

- **Purpose**: Free offline Speech-to-Text using Faster-Whisper
- **Model**: Faster-Whisper (base/small)
- **Files**:
  - `SKILL.md` - Documentation
  - `stt.py` - Python CLI tool
  - `tool.json` - Tool schema

### 3. camera-vision (skills/camera-vision/)

- **Purpose**: Camera image capture and vision analysis
- **Model**: qwen3.5-9B (multimodal via Ollama)
- **Features**:
  - 100% free, works offline
  - No external API required
  - Native multimodal (text + image)
- **Files**:
  - `SKILL.md` - Documentation
  - `vision.py` - Python CLI tool
  - `tool.json` - Tool schema

### 4. qwen-brain (skills/qwen-brain/)

- **Purpose**: Central reasoning engine
- **Model**: qwen3.5-9B (via Ollama)
- **Features**:
  - Multimodal (text, images, video)
  - Thinking mode
  - 262K context (~1M extended)
  - 201 languages
- **Files**:
  - `SKILL.md` - Documentation
  - `setup.py` - Setup script
  - **Benchmark Comparison**:
    - MMMU-Pro: 70.1 (GPT-5-Nano: 57.2)
    - MathVision: 78.9 (GPT-5-Nano: 62.2)
    - Beats Qwen3-30B (3x size) on GPQA

## Research Findings

### qwen3.5-9B Specifications

| Feature       | Specification        |
| ------------- | -------------------- |
| Release       | 2026-02-16 (Alibaba) |
| Type          | Dense Model          |
| Parameters    | 9B                   |
| Context       | 262K (~1M extended)  |
| Multimodal    | Text, Images, Video  |
| Thinking Mode | ✓                    |
| License       | Apache 2.0           |

### Why qwen3.5-9B?

1. **Multimodal Native** - Same weights handle text + images + video
2. **Thinking Mode** - Enhanced reasoning capabilities
3. **Longer Context** - 262K tokens (extendable to 1M)
4. **Benchmarks** - Beats 3x larger models
5. **Local Deployment** - Runs on single RTX 4090 (~5GB VRAM @ 4-bit)

## Setup Instructions

```bash
# 1. Install Ollama
# https://ollama.com/download/windows

# 2. Start Ollama
ollama serve

# 3. Download qwen3.5-9B
ollama pull qwen3.5:9b

# 4. Set environment
set OLLAMA_API_KEY=ollama-local

# 5. Configure OpenClaw
openclaw config set agents.defaults.model.primary "ollama/qwen3.5:9b"

# 6. Install Python dependencies
pip install opencv-python-headless requests faster-whisper sounddevice

# 7. Start VOICEVOX (for TTS)
# Download from https://voicevox.hiroshiba.jp/
```

## Cost Analysis

| Component      | Cost               |
| -------------- | ------------------ |
| qwen3.5-9B     | FREE (Ollama)      |
| Faster-Whisper | FREE (offline)     |
| VOICEVOX       | FREE (open source) |
| Camera         | FREE (built-in)    |
| **Total**      | **100% FREE**      |

## Files Modified

- Added: `skills/voicevox-tts/` (3 files)
- Added: `skills/voicevox-stt/` (3 files)
- Added: `skills/camera-vision/` (3 files)
- Added: `skills/qwen-brain/` (2 files)

## Git Commit

```
[main 29494659c2] Add free AI skills: voicevox-tts, voicevox-stt, camera-vision, qwen-brain with qwen3.5-9B
 11 files changed, 1046 insertions(+)
```

## ASI_ACCEL
