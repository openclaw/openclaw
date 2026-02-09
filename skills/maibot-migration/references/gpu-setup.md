# GPU Pipeline Setup Guide

Video generation pipeline requires NVIDIA GPU + CUDA.

## Requirements

- NVIDIA GPU (RTX 3060+ recommended, 8GB+ VRAM)
- CUDA Toolkit 11.8+
- Python 3.10+
- ~15GB disk space

## Step-by-Step

### 1. Python Virtual Environments

```bash
cd MAIBEAUTY

# TTS venv (edge-tts — no GPU needed, but MMS-TTS fallback uses GPU)
python -m venv .venv-tts
.venv-tts/Scripts/activate  # Windows
pip install edge-tts boto3 python-dotenv
# For MMS-TTS fallback:
pip install torch transformers soundfile numpy

# Avatar venv (SadTalker — GPU required)
python -m venv .venv-avatar
.venv-avatar/Scripts/activate  # Windows
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

### 2. SadTalker

```bash
cd vendor
git clone https://github.com/OpenTalker/SadTalker.git
cd SadTalker
pip install -r requirements.txt
# Download pretrained models
bash scripts/download_models.sh
```

### 3. FFmpeg

- **Windows**: Download from https://ffmpeg.org/download.html → extract to `vendor/ffmpeg/`
- **macOS**: `brew install ffmpeg`
- **Linux**: `sudo apt install ffmpeg`

Worker expects ffmpeg at: `vendor/ffmpeg/ffmpeg-7.1.1-essentials_build/bin/ffmpeg.exe` (Windows)
Adjust path in scripts if different.

### 4. Ollama (Local LLM for script generation)

```bash
# Install from https://ollama.ai
ollama pull qwen3:8b
```

### 5. Verify

```bash
# GPU check
nvidia-smi

# TTS test
python -c "import edge_tts; print('edge-tts OK')"

# SadTalker test
cd vendor/SadTalker
python inference.py --driven_audio examples/driven_audio/bus_chinese.wav --source_image examples/source_image/happy.png --result_dir output

# Ollama test
ollama run qwen3:8b "Hello"
```

## Performance Reference (RTX 4070 Super)

| Step | Time | Notes |
|------|------|-------|
| Script (Ollama qwen3:8b) | ~12s | CPU-bound |
| TTS (edge-tts) | ~15s | Network (Microsoft API) |
| Avatar (SadTalker 256px) | ~130s | GPU-bound, ~12GB VRAM |
| FFmpeg (720×1280) | ~5s | CPU-bound |
| R2 Upload | ~2s | Network |
| **Total** | **~2.5 min** | **$0 cost** |
