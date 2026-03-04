---
name: voicevox-stt-skill
description: Free offline Speech-to-Text using Faster-Whisper. Converts microphone audio to text locally.
short_description: Free offline STT with Faster-Whisper
---

# Voicevox STT Skill

This skill provides free offline speech-to-text using Faster-Whisper.

## Requirements

1. **Python 3.8+**
2. **Faster-Whisper**:

   ```bash
   pip install faster-whisper
   ```

3. **FFmpeg** (for audio processing):
   - Windows: Download from https://ffmpeg.org/download.html
   - Or: `pip install ffmpeg-python`

## Usage

### As a Tool

```
Tool: voicevox_stt
Input: { "duration": 5, "language": "ja" }
```

### Direct Python Usage

```python
from faster_whisper import WhisperModel

# Download model first (one-time)
# faster-whisper will auto-download on first run

model_size = "base"  # tiny, base, small, medium, large
model = WhisperModel(model_size, device="cpu", compute_type="int8")

segments, info = model.transcribe("audio.wav", language="ja")

for segment in segments:
    print(segment.text)
```

## Recording Microphone

```python
import sounddevice as sd
import numpy as np
from faster_whisper import WhisperModel

# Record audio
duration = 5  # seconds
sample_rate = 16000
audio = sd.rec(int(duration * sample_rate), samplerate=sample_rate, channels=1)
sd.wait()

# Transcribe
model = WhisperModel("base", device="cpu", compute_type="int8")
segments, info = model.transcribe(audio, language="ja")

for segment in segments:
    print(segment.text)
```

## Model Sizes

| Model  | Parameters | RAM   | Speed   |
| ------ | ---------- | ----- | ------- |
| tiny   | 39M        | ~1GB  | Fastest |
| base   | 74M        | ~1GB  | Fast    |
| small  | 244M       | ~2GB  | Medium  |
| medium | 769M       | ~5GB  | Slow    |
| large  | 1550M      | ~10GB | Slowest |

**Recommendation**: Use `base` or `small` for balance of speed and accuracy.

## Integration

### With qwen3.5-8B Brain

This skill can be combined with voicevox-tts-skill for full voice conversation:

```
User Voice → voicevox_stt → qwen3.5-8b → voicevox_tts → Voice Output
```

## Troubleshooting

- **No microphone**: Check Windows microphone permissions
- **Slow transcription**: Use smaller model (tiny/base)
- **Memory error**: Use int8 quantization

## Cost

**FREE** - Faster-Whisper runs completely offline.

ASI_ACCEL.
