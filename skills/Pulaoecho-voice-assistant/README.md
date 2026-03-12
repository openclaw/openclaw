# Pulaoecho Remote Audio Device Voice Assistant

## Overview

A WebSocket-based remote audio device voice assistant service. Remote devices (such as Pulaoecho hardware) continuously send PCM audio streams through WebSocket. The server uses VAD to detect voice segments in real-time, trigger wake word recognition and command recognition, query OpenClaw, and send TTS audio back to the device.

## Architecture

```
Remote Audio Device
    │  PCM audio stream (80ms/chunk, base64)
    │  Control signals (wakeup/process/feedback/sleep)
    ▼
WebSocketAudioServer          ← asyncio event loop, pure forwarding
    │
AudioBridge                   ← Thread-safe buffer layer
    ├─ AudioReceiveQueue       ← Device audio → VA
    └─ AudioSendQueue          ← TTS audio → Device
    │
VoiceAssistantRemote
    ├─ recording_thread        ← VAD segmentation + async ASR, never blocking
    │    └─ SpeechRecognizer   ← Per-sentence independent thread recognition, callback return
    ├─ execution_thread        ← Query OpenClaw gateway
    └─ tts_thread              ← gTTS generate PCM, send sleep signal after queue empty
```

**Key Design Principle**: The recording thread never blocks — after VAD segments the voice, it immediately submits to `SpeechRecognizer`, which calls ASR in an independent thread, and results are asynchronously returned to the recording loop via `_asr_result_q`. The user can wake up again at any time to interrupt ongoing recognition/TTS.

## WebSocket Communication Protocol

### Service Endpoint

```
ws://{server_ip}:18181/v1/audio/stream
```

Default port: `18181`

### Message Format

#### 1. Audio Data Upstream (Device → Server)

**Mono channel mode**:

```json
{
  "proto": 1,
  "seq": 123456,
  "type": "audio",
  "format": "pcm",
  "sampleRate": 16000,
  "channels": 1,
  "bits": 16,
  "txdata": "base64 encoded PCM audio data",
  "ts": 1739876543210
}
```

**Stereo channel mode**:

```json
{
  "proto": 1,
  "seq": 123456,
  "type": "audio",
  "format": "pcm",
  "sampleRate": 16000,
  "channels": 2,
  "bits": 16,
  "txdata": "base64 encoded PCM audio data (TX)",
  "rxdata": "base64 encoded PCM audio data (RX)",
  "ts": 1739876543210
}
```

**Field Description**:

| Field Name | Type   | Fixed Value    | Description                              |
| ---------- | ------ | -------------- | ---------------------------------------- |
| proto      | int    | 1              | Protocol version, permanently fixed      |
| seq        | long   | Auto-increment | Message sequence number, starting from 0 |
| type       | string | audio          | Fixed as audio stream                    |
| format     | string | pcm            | Audio format fixed                       |
| sampleRate | int    | 16000          | Sampling rate                            |
| channels   | int    | 1/2            | Number of channels                       |
| bits       | int    | 16             | Bit depth                                |
| txdata     | string | BASE64         | 80ms PCM audio Base64 encoded            |
| rxdata     | string | BASE64         | (Optional) Received audio Base64 encoded |
| ts         | long   | Timestamp      | Millisecond Unix timestamp               |

#### 2. Audio Data Downstream (Server → Device)

```json
{
  "proto": 1,
  "type": "audio",
  "format": "pcm",
  "sampleRate": 16000,
  "channels": 1,
  "bits": 16,
  "data": "base64 encoded PCM audio",
  "ts": 1739876543999
}
```

#### 3. Heartbeat

**Upstream (Device → Server)**:

```json
{
  "proto": 1,
  "type": "ping",
  "ts": 1739876543210
}
```

**Downstream (Server → Device)**:

```json
{
  "proto": 1,
  "type": "pong",
  "ts": 1739876543567
}
```

**Heartbeat Rules**:

- Device sends `ping` every 30 seconds
- Reconnect if no `pong` for 180 seconds

#### 4. Status Notification Messages

**Wake-up Response** (returned immediately after wake word detection):

```json
{
  "proto": 1,
  "type": "wakeup",
  "ts": 1739876543567
}
```

**Query Result Response** (sent when returning OpenClaw result):

```json
{
  "proto": 1,
  "type": "feedback",
  "ts": 1739876543567
}
```

**Sleep Notification** (timeout after wake-up without command, enter idle state):

```json
{
  "proto": 1,
  "type": "sleep",
  "ts": 1739876543567
}
```

## Workflow

```
Device connection → Continuous audio sending (80ms/chunk)
    ↓
VAD real-time voice segmentation
    ↓
SpeechRecognizer asynchronous recognition (independent thread, non-blocking recording)
    ↓
Wake word detected → Send wakeup, enter awakened state
    ↓
Question recognized → Send process, query OpenClaw
    ↓
Response received → Send feedback, gTTS generate PCM and send back to device
    ↓
Send queue emptied → Send sleep, return to waiting state
```

At any time, if a wake word is detected, it will immediately interrupt the current recognition/TTS and re-enter the awakened state.

## Installation

```bash
cd skills/Pulaoecho-voice-assistant
pip3 install -r requirements.txt
```

`pydub` requires `ffmpeg`:

```bash
brew install ffmpeg   # macOS
```

## Usage

### 1. Generate Self-Signed Certificate

First, generate a self-signed certificate for your local machine:

```bash
cd skills/Pulaoecho-voice-assistant
chmod +x scripts/gen_cert.sh
./scripts/gen_cert.sh
```

This will create the certificate files in the `certs/` directory.

### 2. Configure Password

Edit the `config.json` file and set your password:

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 18181,
    "tls": {
      "enabled": true,
      "certFile": "./certs/server.crt",
      "keyFile": "./certs/server.key"
    },
    "password": "your_password_here"
  },
  ...
}
```

### 3. Configure PulaoEcho App

1. Open the PulaoEcho app on your device
2. Enable the OpenClaw switch
3. Fill in the following information:
   - **URL**: `wss://your_server_ip:18181/v1/audio/stream`
   - **Certificate**: Copy the content of `certs/server.crt`
   - **Password**: The password you set in `config.json`
4. Click "Save"

### 4. Verify Connection

After successful connection:

- The volume up and volume down buttons on your device will flash 5 times
- You can see the device connection information in your OpenClaw backend

## Start

```bash
cd scripts
python3 main.py
```

Logs are output to `~/.openclaw/logs/pulaoecho-voice-assistant.log` and also printed to stdout.

```bash
tail -f ~/.openclaw/logs/pulaoecho-voice-assistant.log
```

## Configuration

Modify in `scripts/voice_assistant_remote.py` in `VoiceAssistantRemote.__init__`:

| Parameter | Default Value          | Description              |
| --------- | ---------------------- | ------------------------ |
| `ws_url`  | `ws://127.0.0.1:18789` | OpenClaw gateway address |
| `token`   | hardcoded              | OpenClaw operator token  |

VAD parameters in `recording_thread`:

| Parameter                 | Default Value | Description                                           |
| ------------------------- | ------------- | ----------------------------------------------------- |
| `SILENCE_FRAMES_WAITING`  | 8 (160ms)     | Silence trigger threshold in waiting state            |
| `SILENCE_FRAMES_AWAKENED` | 6 (120ms)     | Silence trigger threshold in awakened state           |
| `MIN_SPEECH_FRAMES`       | 8 (160ms)     | Minimum valid speech (below this is considered noise) |
| `QUEUE_TIMEOUT`           | 1.5s          | Force flush after device audio timeout                |

Wake words in `_on_asr_result`: `["hi claw", "hey claw", "hi google", "hey google"]`

## Testing

Step-by-step test (wake word + question in two files):

```bash
cd test
python3 step_by_step_test.py
```

Single file continuous test (wake word + question in one WAV):

```bash
python3 single_file_test.py test1.wav
```

TTS response audio is saved in `test/output/`.

## Troubleshooting

**Speech recognition failure**: Requires network access to ASR API, check PCM format (16kHz, 16-bit, mono).

**OpenClaw query failure**:

```bash
openclaw gateway status
openclaw channels status --probe
```

**Port conflict**:

```bash
lsof -i :18181
```

## License

Consistent with the main OpenClaw project
