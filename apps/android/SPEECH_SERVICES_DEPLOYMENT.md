# OpenClaw Speech Services Deployment Guide

## Overview

This guide explains how to deploy Whisper.cpp ASR (speech-to-text) and Fish Speech TTS (text-to-speech) services for the OpenClaw Android app.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Android App    │────▶│  Speech Gateway  │────▶│  Whisper ASR    │
│                 │     │   (ub22:10800)   │     │  (ub22:10801)   │
│                 │     │                  │     │                 │
│                 │────▶│                  │────▶│  Fish Speech    │
│                 │     │                  │     │  (ub22:10802)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Prerequisites

- ub22 server with NVIDIA GPU
- Docker and Docker Compose installed
- 轩辕专属域名 (Xuanyuan proxy domain) for pulling Docker images

## Deployment Steps

### Step 1: Get Your 轩辕专属域名

1. Login to https://xuanyuan365.com
2. Click「专属域名」in the left sidebar
3. Copy your domain (e.g., `3jkpkp4ngyen9a.xuanyuan.run`)

### Step 2: Deploy Services

Run the deployment script from your workstation:

```bash
cd /home/iouoi/openclaw/apps/android
./scripts/deploy-speech-services.sh 3jkpkp4ngyen9a.xuanyuan.run
```

This script will:
1. Copy docker-compose.yml to ub22
2. Download Whisper models (large-v3-turbo-q5_0, silero_vad)
3. Pull Docker images via 轩辕 proxy
4. Start all services

### Step 3: Verify Deployment

```bash
# Check service status
ssh ub22 "cd /home/an/openclaw-speech && docker compose ps"

# View logs
ssh ub22 "cd /home/an/openclaw-speech && docker compose logs -f whisper-asr"
ssh ub22 "cd /home/an/openclaw-speech && docker compose logs -f fish-speech"

# Test Whisper ASR
curl http://ub22:10801/health

# Test Fish Speech TTS
curl http://ub22:10802/health
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| Whisper ASR | 10801 | Speech-to-text using Whisper large-v3-turbo |
| Fish Speech TTS | 10802 | Text-to-speech using Fish Speech OpenAudio |

## Android Integration

The Android app automatically detects and uses the remote speech services when available.

### Configuration

Edit `RemoteSpeechService.kt` to customize:

```kotlin
val config = RemoteSpeechConfig.create(
    whisperHost = "ub22",
    whisperPort = 10801,
    fishSpeechHost = "ub22",
    fishSpeechPort = 10802,
)
```

### Usage

```kotlin
val service = RemoteSpeechService(context, scope, config)

// Check connection
val connected = service.checkConnection()

// Transcribe audio
val text = service.transcribeAudio(audioData)

// Synthesize speech
service.synthesizeSpeech(text)
```

## Troubleshooting

### Services Won't Start

```bash
# Check Docker logs
ssh ub22 "docker compose logs"

# Check GPU availability
ssh ub22 "nvidia-smi"

# Restart services
ssh ub22 "cd /home/an/openclaw-speech && docker compose restart"
```

### Model Download Failed

```bash
# Manually download models
ssh ub22 "bash /home/an/whisper.cpp/models/download-ggml-model.sh large-v3-turbo-q5_0"
ssh ub22 "bash /home/an/whisper.cpp/models/download-vad-model.sh"
```

### Network Issues

If you can't pull images:
1. Verify your 轩辕专属域名 is active
2. Test connectivity: `curl https://docker.xuanyuan365.com/v2/`
3. Check DNS: `nslookup docker.xuanyuan365.com`

## Cleanup

```bash
# Stop services
ssh ub22 "cd /home/an/openclaw-speech && docker compose down"

# Remove all data
ssh ub22 "rm -rf /home/an/openclaw-speech"
```
