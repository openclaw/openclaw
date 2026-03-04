---
name: camera-vision-skill
description: Camera image capture and vision analysis using qwen3.5-9B (multimodal). 100% free, runs locally via Ollama.
short_description: Camera vision with qwen3.5-9B (local, free)
---

# Camera Vision Skill

This skill provides camera capture and vision analysis using qwen3.5-9B (multimodal model).

## Why qwen3.5-9B?

| Feature     | qwen3.5-9B              | Gemini-2.0-flash    |
| ----------- | ----------------------- | ------------------- |
| **Cost**    | 100% FREE               | Free tier limited   |
| **Offline** | ✓ Works offline         | ✗ Requires API      |
| **Privacy** | All local               | Data sent to Google |
| **Setup**   | One-time model download | API key required    |

## Requirements

1. **Ollama** installed:
   - Windows: Download from https://ollama.com/download/windows

2. **Download qwen3.5-9B**:

   ```bash
   ollama pull qwen3.5:9b
   ```

3. **Python packages**:
   ```bash
   pip install opencv-python-headless requests
   ```

## Usage

### As a Tool

```
Tool: camera_vision
Input: { "prompt": "Describe what you see" }
```

### Direct Python Usage

```python
import cv2
import base64
import requests
import json

# Capture image
cap = cv2.VideoCapture(0)
ret, frame = cap.read()
cap.release()

# Encode to base64
_, buffer = cv2.imencode('.jpg', frame)
image_base64 = base64.b64encode(buffer).decode('utf-8')

# Analyze with qwen3.5-9B via Ollama
response = requests.post(
    "http://localhost:11434/api/chat",
    json={
        "model": "qwen3.5:9b",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe what you see in this image."},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}}
                ]
            }
        ]
    }
)
result = response.json()
print(result["message"]["content"])
```

## Camera Devices

| Platform | Library       | Example               |
| -------- | ------------- | --------------------- |
| Windows  | opencv-python | `cv2.VideoCapture(0)` |
| macOS    | opencv-python | `cv2.VideoCapture(0)` |
| Linux    | opencv-python | `cv2.VideoCapture(0)` |

## Integration

### With qwen3.5-9B Brain (Recommended)

Full voice vision pipeline (100% free, local):

```
Camera → camera_vision → qwen3.5:9b → voicevox_tts → Voice Output
```

### Vision Benchmarks (qwen3.5:9B)

- **MMMU-Pro**: 70.1 (beats GPT-5-Nano: 57.2)
- **MathVision**: 78.9 (beats GPT-5-Nano: 62.2)
- **OmniDocBench**: 87.7 (beats GPT-5-Nano: 55.9)
- **Vision**: Beats Gemini-2.5-Flash-Lite by double digits

## Troubleshooting

- **No camera**: Check camera permissions in OS settings
- **Connection refused**: Start Ollama with `ollama serve`
- **Model not found**: Run `ollama pull qwen3.5:9b`
- **Slow**: Use smaller model `ollama pull qwen3.5:4b`

## Cost

**100% FREE** - Ollama + qwen3.5:9B runs completely offline.

**License**: Apache 2.0 - Commercial use allowed.

ASI_ACCEL.
