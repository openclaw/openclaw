---
name: qwen-brain-skill
description: Ollama qwen3.5-9B as the central brain. Multimodal native model with thinking mode, 262K context, free autonomous operation.
short_description: qwen3.5-9B multimodal brain with Ollama
---

# Qwen Brain Skill

This skill configures qwen3.5-9B as the central reasoning engine using Ollama.

## Why qwen3.5-9B?

| Feature       | qwen3.5-9B            | qwen3:8b    |
| ------------- | --------------------- | ----------- |
| Multimodal    | ✓ Text, Images, Video | ✗ Text only |
| Context       | 262K (~1M拡張可)      | 32K         |
| Thinking Mode | ✓                     | ✗           |
| Benchmarks    | Beats 30B models      | -           |
| VRAM (4-bit)  | ~5GB                  | ~5GB        |

### Benchmarks (vs 3x larger models)

- **GPQA**: Beats Qwen3-30B
- **MMMU-Pro**: 70.1 (GPT-5-Nano: 57.2)
- **MathVision**: 78.9 (GPT-5-Nano: 62.2)
- **Vision**: Beats Gemini-2.5-Flash-Lite by double digits

## Requirements

1. **Ollama** installed:
   - Windows: Download from https://ollama.com/download/windows
   - Or: `winget install Ollama.Ollama`

2. **Start Ollama**:

   ```bash
   ollama serve
   ```

3. **Download qwen3.5-9B**:

   ```bash
   ollama pull qwen3.5:9b
   ```

   Other recommended models:
   - `ollama pull qwen3.5:4b` - Smaller, faster
   - `ollama pull qwen3.5:2b` - Minimal VRAM (~4GB)

## Configuration

### Set as Default Model

```bash
# Set default model in OpenClaw
openclaw config set agents.defaults.model.primary "ollama/qwen3.5:9b"
```

### Environment Variables

```bash
# Set Ollama API key (any value works)
set OLLAMA_API_KEY=ollama-local

# Or in your shell profile
echo 'export OLLAMA_API_KEY=ollama-local' >> ~/.profile
```

### Verify Configuration

```bash
openclaw status
```

## Integration with Skills

### Full Voice Vision Pipeline (100% Free)

```
User Voice → voicevox_stt → qwen3.5:9b → voicevox_tts → Voice Output
Camera      → camera_vision → qwen3.5:9b → voicevox_tts → Voice Output
```

### Tool Registration

The qwen brain works with these free tools:

1. **voicevox_tts** - VOICEVOX TTS (free Japanese TTS)
2. **voicevox_stt** - Faster-Whisper STT (free offline STT)
3. **camera_vision** - qwen3.5:9B (NATIVE multimodal - no external API!)

## Model Comparison (Qwen3.5 Small Series)

| Model          | Parameters | VRAM (BF16) | VRAM (4-bit) | Use Case             |
| -------------- | ---------- | ----------- | ------------ | -------------------- |
| qwen3.5:0.8b   | 0.8B       | ~2GB        | ~500MB       | Phone/Edge           |
| qwen3.5:2b     | 2B         | ~4GB        | ~1.5GB       | Lightweight          |
| qwen3.5:4b     | 4B         | ~8GB        | ~3GB         | Balanced             |
| **qwen3.5:9b** | **9B**     | **~18GB**   | **~5GB**     | **Best Performance** |

## Troubleshooting

- **Model not found**: Run `ollama pull qwen3.5:9b`
- **Connection refused**: Start Ollama with `ollama serve`
- **Out of VRAM**: Use `ollama pull qwen3.5:4b` instead

## Cost

**100% FREE** - Ollama runs completely offline, no API costs.

**License**: Apache 2.0 - Commercial use allowed.

ASI_ACCEL.
