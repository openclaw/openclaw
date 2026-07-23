# Sherpa ONNX TTS

Official OpenClaw skill plugin for offline local text-to-speech using
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx).

Install it from ClawHub:

```bash
openclaw plugins install clawhub:@openclaw/sherpa-onnx-tts
```

The plugin ships the `sherpa-onnx-tts` skill plus a cross-platform wrapper.
The skill provides separate gateway-backed download actions for the native
runtime and Piper voice model.

The plugin intentionally does not register an automatic speech provider.
Sherpa ONNX v1.13.2 accepts synthesized text only as a native process argument,
which local process inspection can expose. Treat wrapper text as observable on
the host and do not use it for sensitive content.
