# sherpa-onnx Integration for OpenClaw Android

This document describes the sherpa-onnx ASR and TTS integration for offline speech recognition and synthesis.

## Overview

The sherpa-onnx integration provides:

1. **Offline ASR (Automatic Speech Recognition)** using streaming-paraformer-bilingual-zh-en model
2. **Offline TTS (Text-to-Speech)** using vits-zh-hf model or similar
3. No Google Services required
4. No network connectivity required for speech processing

## Architecture

### Components

1. **SherpaOnnxManager** - Main manager for ASR and TTS instances
   - Handles model initialization
   - Manages lifecycle
   - Provides unified access to speech services

2. **SherpaOnnxRecognizer** - Wrapper for OnlineRecognizer (ASR)
   - Streaming speech recognition
   - Real-time transcription
   - Silence detection
   - VAD (Voice Activity Detection)

3. **SherpaOnnxTts** - Wrapper for OfflineTts
   - Text-to-speech synthesis
   - Speed control
   - Multi-speaker support

4. **TalkModeManagerSherpa** - Modified TalkModeManager
   - Replaces Google SpeechRecognizer with SherpaOnnxRecognizer
   - Replaces ElevenLabs TTS with SherpaOnnxTts
   - Maintains backward compatibility with system TTS fallback

## Model Files

### ASR Model: streaming-paraformer-bilingual-zh-en

**STATUS: ✅ INSTALLED**

Download from:
```bash
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
tar xvf sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
```

Location: `app/src/main/assets/sherpa-onnx/asr/`

Installed files:
- `tokens.txt` (74 KB) - 8404 tokens
- `encoder.onnx` (607 MB) - Full precision encoder
- `encoder.int8.onnx` (158 MB) - Quantized encoder (recommended for mobile)
- `decoder.onnx` (218 MB) - Full precision decoder
- `decoder.int8.onnx` (69 MB) - Quantized decoder (recommended for mobile)
- `README.md` - Model documentation
- `test_wavs/` - Test audio samples

**Model Verification:**
- encoder.onnx MD5: `38bb68f284cf2d34e5a8f98a7c671ffd`
- decoder.onnx MD5: `4eb7c94ece0ad861f18ef56db5f72379`

### TTS Model: vits-icefall-zh-aishell3

**STATUS: ✅ INSTALLED**

Download from:
```bash
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2
tar xvf vits-icefall-zh-aishell3.tar.bz2
```

Location: `app/src/main/assets/sherpa-onnx/tts/`

Installed files:
- `tokens.txt` (1.7 KB) - 219 tokens
- `model.onnx` (30 MB) - Neural network model
- `lexicon.txt` (2.0 MB) - Pronunciation lexicon
- `rule.far` (173 MB) - Text normalization rules
- `date.fst` (58 KB) - Date normalization FST
- `number.fst` (63 KB) - Number normalization FST
- `phone.fst` (87 KB) - Phone normalization FST
- `new_heteronym.fst` (22 KB) - Heteronym disambiguation FST
- `speakers.txt` (1.4 KB) - Speaker list

**Model Verification:**
- model.onnx MD5: `2f271db3fdfa54fed50837efbe516114`

### Installation Summary

**Total Model Size:** ~1.3 GB
- ASR Model: ~1.1 GB
- TTS Model: ~204 MB

**Installation Date:** February 24, 2026

Both models have been successfully downloaded, verified, and installed in the assets directory.

### Alternative Models

See sherpa-onnx documentation for additional language models:
- https://github.com/k2-fsa/sherpa-onnx

## Native Library (JNI)

### Building sherpa-onnx for Android

1. Clone sherpa-onnx:
```bash
git clone https://github.com/k2-fsa/sherpa-onnx
cd sherpa-onnx
```

2. Build for Android:
```bash
./build-android.sh
```

3. Copy native library:
```bash
cp build-android/src/main/jniLibs/* /path/to/openclaw/apps/android/app/src/main/jniLibs/
```

Or use pre-built AAR from releases:
```bash
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.10.0/sherpa-onnx-android-1.10.0.aar
cp sherpa-onnx-android-1.10.0.aar /path/to/openclaw/apps/android/app/libs/
```

### JNI Bindings

The native library provides these functions:

**ASR:**
- `Java_ai_openclaw_android_voice_SherpaOnnxRecognizer_createRecognizer`
- `Java_ai_openclaw_android_voice_SherpaOnnxRecognizer_destroyRecognizer`
- `Java_ai_openclaw_android_voice_SherpaOnnxRecognizer_createStream`
- `Java_ai_openclaw_android_voice_SherpaOnnxRecognizer_resetStream`
- `Java_ai_openclaw_android_voice_SherpaOnnxRecognizer_acceptWaveform`
- `Java_ai_openclaw_android_voice_SherpaOnnxRecognizer_decodeInternal`
- `Java_ai_openclaw_android_voice_SherpaOnnxRecognizer_getResult`

**TTS:**
- `Java_ai_openclaw_android_voice_SherpaOnnxTts_createTts`
- `Java_ai_openclaw_android_voice_SherpaOnnxTts_destroyTts`
- `Java_ai_openclaw_android_voice_SherpaOnnxTts_generateAudio`
- `Java_ai_openclaw_android_voice_SherpaOnnxTts_getSampleRate`
- `Java_ai_openclaw_android_voice_SherpaOnnxTts_getNumSpeakers`

## Usage

### Initialization

```kotlin
val talkManager = TalkModeManagerSherpa(
    context = context,
    scope = viewModelScope,
    session = gatewaySession,
    supportsChatSubscribe = true,
    isConnected = { gatewaySession.isConnected }
)

// Initialize sherpa-onnx (optional, uses defaults if not specified)
lifecycleScope.launch {
    val initialized = talkManager.initializeSherpa(
        asrModel = "sherpa-onnx-streaming-paraformer-bilingual-zh-en",
        ttsModel = "vits-zh-hf"
    )
    if (initialized) {
        Log.d("Talk", "sherpa-onnx ready")
    }
}
```

### Enabling Talk Mode

```kotlin
talkManager.setEnabled(true)
```

### Monitoring State

```kotlin
talkManager.isEnabled.collect { enabled ->
    // Talk mode enabled state
}

talkManager.isListening.collect { listening ->
    // ASR listening state
}

talkManager.isSpeaking.collect { speaking ->
    // TTS speaking state
}

talkManager.sherpaInitializing.collect { initializing ->
    // Initialization progress
}

talkManager.usingFallbackTts.collect { fallback ->
    // Using system TTS fallback
}
```

## Configuration

### TTS Settings

Set via gateway config or environment:

```json
{
  "talk": {
    "ttsSpeed": 1.0,
    "speakerId": 0
  }
}
```

Or via TalkDirective:
```
{"speed": 1.0, "speakerId": 0}
Your response text here.
```

## Performance Considerations

1. **Model Size**: ASR models are ~100-200MB, TTS models ~50-100MB
2. **Initial Load**: First-time model extraction takes 5-10 seconds
3. **Memory Usage**: ~300-500MB with both ASR and TTS loaded
4. **CPU Usage**: Higher during recognition and synthesis
5. **Battery**: Moderate impact during active speech processing

## Troubleshooting

### Models not loading
- Verify model files are in assets directory
- Check file permissions
- Enable verbose logging: `adb shell setprop log.tag.SherpaOnnx* DEBUG`

### ASR not recognizing
- Check microphone permission
- Verify audio format (16kHz, mono, PCM-16)
- Check silence detection threshold

### TTS not speaking
- Verify model files
- Check audio focus
- Ensure speakerId is valid for the model

### Native library not found
- Confirm JNI library architecture matches device ABI
- Rebuild native library for target architectures

## Future Enhancements

1. Support for additional languages
2. Voice cloning TTS models
3. Streaming TTS for lower latency
4. Custom model training
5. Model quantization for smaller size
