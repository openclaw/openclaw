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

## Architecture Refactoring

### Goal

Use WebSocket connection ID (`device_id`) as the unique identifier throughout the entire data flow to achieve complete multi-device isolation.

### Core Principle

**Every data packet carries `device_id`, tracked from audio input to TTS output**

### Current Architecture Issues

1. **Global state dependency**: Uses global variables like `active_device_id` and `last_audio_device_id`
2. **Device ID loss**: Audio packets lose `device_id` information during processing
3. **Unreliable routing**: Relies on easily overwritten mechanisms like `last_audio_device_id`
4. **Concurrent conflicts**: Routing errors are likely during multi-device concurrency

### Ideal Architecture

```
WebSocket (device_id)
  → AudioBridge.write_audio(device_id, audio)
  → VoiceAssistant.recording_thread 获取 (device_id, audio)
  → ASR.submit(device_id, audio, callback)
  → ASR callback 返回 (device_id, text)
  → VoiceAssistant.task_queue.put((device_id, question, generation))
  → VoiceAssistant.execution_thread 处理 (device_id, question)
  → OpenClaw 查询
  → VoiceAssistant.speak_queue.put((device_id, answer, generation))
  → TTS 生成
  → AudioBridge.send_tts_audio(device_id, audio)
  → WebSocketServer 路由到对应 WebSocket 连接
```

### Completed Modifications

#### 1. AudioBridge (`scripts/audio_bridge.py`)

✅ **New architecture methods**:

- `write_audio(device_id, data)` - Write with device ID
- `get_audio_packet() -> (device_id, data)` - Read returns device ID
- `send_tts_audio(device_id, audio)` - TTS sent to specified device
- `send_signal(device_id, signal_type)` - Signal sent to specified device

✅ **Compatibility layer** (preserved for old code):

- `set_active_device(device_id)`
- `queue_tts_audio(audio)`
- `clear_send_queue()`
- `start_send_thread()` / `stop_send_thread()`

#### 2. WebSocketAudioServer (`scripts/websocket_audio_server.py`)

✅ **Updated**:

- `_on_tts_audio(device_id, audio_chunk)` - Accepts device ID parameter
- `_on_signal(device_id, signal_type)` - Accepts device ID parameter
- `handle_audio()` - Calls `write_audio(device_id, data)`

### Pending Modifications

#### 3. VoiceAssistantRemote (`scripts/voice_assistant_remote.py`)

##### 3.1 recording_thread

**Current**:

```python
# Global state
rec_state = "waiting"
collected_text = []
speech_frames = []

# Get audio
packet = self.audio_bridge.get_audio_packet()
frame_buf.extend(packet)

# Submit ASR
_submit(pcm)
```

**Target**:

```python
# Per-device independent state
device_states = {}  # {device_id: {'state': ..., 'collected': ..., 'speech_frames': ...}}

# Get audio (with device ID)
packet = self.audio_bridge.get_audio_packet()
if packet:
    device_id, raw_packet = packet
    dev_state = get_device_state(device_id)
    dev_state['frame_buf'].extend(raw_packet)

# Submit ASR (with device ID)
_submit(device_id, pcm, dev_state['state'], dev_state['collected'])
```

##### 3.2 ASR Callback

**Current**:

```python
def _on_asr_result(req_id, text):
    # Use device_id from snapshot
    snapshot_state, snapshot_collected, snapshot_device_id = snapshot

    # Submit task
    self.task_queue.put(question)
    self._asr_result_q.put(("waiting", []))
```

**Target**:

```python
def _on_asr_result(req_id, text):
    snapshot_state, snapshot_collected, snapshot_device_id = snapshot

    # Submit task (with device ID and generation)
    self.task_queue.put((snapshot_device_id, question, generation))
    self._asr_result_q.put((snapshot_device_id, "waiting", []))
```

##### 3.3 execution_thread

**Current**:

```python
question = self.task_queue.get()
answer = self._query_openclaw(question)
self.speak_queue.put((answer, generation))
```

**Target**:

```python
device_id, question, generation = self.task_queue.get()
answer = self._query_openclaw(question)
# Send signal to specified device
self.audio_bridge.send_signal(device_id, "feedback")
# Submit TTS (with device ID)
self.speak_queue.put((device_id, answer, generation))
```

##### 3.4 tts_thread

**Current**:

```python
text, generation = self.speak_queue.get()
# Generate TTS
self.audio_bridge.queue_tts_audio(mp3_data)
self.audio_bridge.send_signal("sleep")
```

**Target**:

```python
device_id, text, generation = self.speak_queue.get()
# Set active device (compatibility layer)
self.audio_bridge.set_active_device(device_id)
# Generate TTS (sent through compatibility layer)
self.audio_bridge.queue_tts_audio(mp3_data)
# Send signal to specified device
self.audio_bridge.send_signal(device_id, "sleep")
```

### Implementation Steps

#### Phase 1: Minimal Modifications (Current State)

✅ System can run using compatibility layer
✅ WebSocket layer already uses new architecture
⚠️ Device routing may still have issues (relies on snapshot mechanism)

#### Phase 2: Complete Refactoring (Recommended)

1. **Modify recording_thread**
   - Implement per-device independent state management
   - Handle `(device_id, audio)` tuples
   - Carry `device_id` when submitting ASR

2. **Modify ASR callback**
   - All queue operations include `device_id`
   - `task_queue`: `(device_id, question, generation)`
   - `_asr_result_q`: `(device_id, state, collected)`

3. **Modify execution_thread**
   - Handle `(device_id, question, generation)` tuples
   - Specify `device_id` when sending signals

4. **Modify tts_thread**
   - Handle `(device_id, text, generation)` tuples
   - Route TTS through `device_id`

5. **Remove compatibility layer** (optional)
   - Remove global states like `active_device_id`
   - Remove `send_queue` and `send_thread`
   - Directly use new architecture callbacks

### Testing Verification

#### Test Scenarios

1. **Single device test**
   - Wake up → ask question → receive correct response

2. **Dual device concurrent test**
   - Device A wakes up → Device B wakes up → each receives correct response
   - Device A asks question → Device B sends audio → Device A receives response

3. **Device switching test**
   - Device A wakes up → Device B wakes up → Device B receives response
   - Device A in middle of question → Device B wakes up → Device A's response is interrupted

#### Verification Points

- ✅ TTS responses sent to correct device
- ✅ Signals (wakeup, feedback, sleep) sent to correct device
- ✅ Multi-device concurrency without interference
- ✅ Correct interruption of previous device's task during device switching

### Current System Status

- ✅ System can run
- ✅ WebSocket layer uses new architecture
- ✅ AudioBridge supports both old and new architectures
- ⚠️ VoiceAssistant still uses old architecture (works through compatibility layer)
- ⚠️ Device routing may still have issues

### Next Steps

**Option A**: Test current system, confirm device routing issues
**Option B**: Complete full architecture refactoring according to this document
**Option C**: Create new `voice_assistant_v2.py` implementing new architecture, keep old version as backup

## ASR Engine Support

The system now supports two ASR engines:

### 1. Aliyun ASR (Online)

- **Model**: qwen3-asr-flash
- **Features**: Cloud-based, high accuracy
- **Requirements**: Internet connection, API key

### 2. Sherpa-ONNX (Offline)

- **Model**: Local ONNX models
- **Features**: Offline operation, no network required
- **Requirements**: ONNX model files

### Configuration

Set the ASR engine in `config.json`:

```json
{
  "asrEngine": "aliyun", // or "sherpa-onnx"
  "aliyunASR": {
    "apiKey": "your_api_key",
    "model": "qwen3-asr-flash",
    "language": "en"
  },
  "sherpaONNX": {
    "modelDir": "./models/sherpa-onnx"
  }
}
```

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

**Speech recognition failure**: Requires network access to ASR API (for Aliyun) or correct ONNX models (for Sherpa-ONNX), check PCM format (16kHz, 16-bit, mono).

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
