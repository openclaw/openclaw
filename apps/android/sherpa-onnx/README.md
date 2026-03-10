# sherpa-onnx Integration for OpenClaw Android

This directory contains the sherpa-onnx native library and JNI bindings for offline speech recognition and text-to-speech.

## Quick Start

### Option 1: Download Pre-built Library (Recommended)

```bash
cd apps/android
./scripts/build-sherpa-onnx.sh download
```

This downloads the pre-compiled AAR from GitHub releases and extracts the native libraries.

### Option 2: Build from Source

```bash
cd apps/android
./scripts/build-sherpa-onnx.sh build
```

This will:
1. Clone sherpa-onnx repository
2. Build for all Android architectures (arm64-v8a, armeabi-v7a, x86, x86_64)
3. Package into AAR file
4. Extract native libraries to `app/src/main/jniLibs/`

## Directory Structure

```
app/
├── libs/
│   └── sherpa-onnx-android-v1.10.4.aar    # Pre-built AAR (if downloaded)
├── src/main/
│   ├── jniLibs/                            # Native libraries (.so files)
│   │   ├── arm64-v8a/libsherpa-onnx-jni.so
│   │   ├── armeabi-v7a/libsherpa-onnx-jni.so
│   │   ├── x86/libsherpa-onnx-jni.so
│   │   └── x86_64/libsherpa-onnx-jni.so
│   └── java/ai/openclaw/android/voice/
│       ├── SherpaOnnxManager.kt             # Main manager
│       ├── SherpaOnnxRecognizer.kt          # ASR wrapper
│       └── SherpaOnnxTts.kt                 # TTS wrapper
```

## Model Files

Models must be placed in `app/src/main/assets/sherpa-onnx/`:

### ASR Model (Chinese + English)
```bash
mkdir -p app/src/main/assets/sherpa-onnx/asr
cd app/src/main/assets/sherpa-onnx/asr
wget https://github.com/k2fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en-2023-02-20.tar.bz2
tar xvf sherpa-onnx-streaming-paraformer-bilingual-zh-en-2023-02-20.tar.bz2
```

### TTS Model (Chinese)
```bash
mkdir -p app/src/main/assets/sherpa-onnx/tts
cd app/src/main/assets/sherpa-onnx/tts
wget https://github.com/k2fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-2024-04-09.tar.bz2
tar xvf vits-zh-hf-2024-04-09.tar.bz2
```

## Building the App

Once native libraries and models are in place:

```bash
cd apps/android
./gradlew assembleDebug
```

Or install to device:
```bash
./gradlew installDebug
```

## Build Script Commands

```bash
./scripts/build-sherpa-onnx.sh download  # Download pre-built binaries
./scripts/build-sherpa-onnx.sh build     # Build from source
./scripts/build-sherpa-onnx.sh setup     # Clone/update repository only
./scripts/build-sherpa-onnx.sh aar       # Create AAR from existing builds
./scripts/build-sherpa-onnx.sh clean     # Remove build artifacts
```

## Requirements

- Android NDK r25 or later
- CMake 3.18+
- Ninja (optional, for faster builds)

Set `ANDROID_NDK_HOME` or `ANDROID_HOME` environment variable if not found automatically.

## Troubleshooting

### Native library not found

```bash
# Verify libraries are in place
find app/src/main/jniLibs -name "*.so"

# Re-download pre-built
./scripts/build-sherpa-onnx.sh clean
./scripts/build-sherpa-onnx.sh download
```

### Build failures

```bash
# Check NDK version
$ANDROID_NDK_HOME/ndk-build --version

# Ensure minimum API level is set
# minSdk = 31 in build.gradle.kts
```

### Model loading errors

- Verify model files are in `app/src/main/assets/sherpa-onnx/`
- Check file permissions: `chmod 644 sherpa-onnx/asr/*/tokens.txt`
- Enable logging: `adb shell setprop log.tag.SherpaOnnx* DEBUG`

## JNI Native Methods

### SherpaOnnxRecognizer (ASR)
- `createRecognizer(config: String): Long`
- `destroyRecognizer(ptr: Long): Unit`
- `createStream(): Unit`
- `resetStream(): Unit`
- `acceptWaveform(samples: ByteArray, size: Int): Unit`
- `decodeInternal(): Unit`
- `getResult(): String`

### SherpaOnnxTts (Text-to-Speech)
- `createTts(config: String): Long`
- `destroyTts(ptr: Long): Unit`
- `generateAudio(ptr: Long, text: String, speed: Float, speakerId: Int): ByteArray`
- `getSampleRate(ptr: Long): Int`
- `getNumSpeakers(ptr: Long): Int`

## Performance

| Metric | Value |
|--------|-------|
| ASR Model Size | ~100-200 MB |
| TTS Model Size | ~50-100 MB |
| Memory Usage | 300-500 MB |
| Init Time | 5-10 seconds (first run) |
| ASR Latency | <200 ms |
| TTS Latency | <500 ms |

## License

sherpa-onnx is licensed under Apache 2.0.
See https://github.com/k2fsa/sherpa-onnx for details.
