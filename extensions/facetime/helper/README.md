# FaceTime Helper

Standalone macOS helper bundle for FaceTime call-control events.

The helper connects directly to the OpenClaw `facetime` plugin over newline-delimited JSON on:

```text
localhost:45670 + uid - 501
```

It emits `ft-call-status-changed` events and accepts existing actions such as `answer-call` and `leave-call`.

The network client uses Foundation streams and has no third-party build
dependencies. The OpenClaw gateway builds this helper from source and supervises
injection into both FaceTime and Phone. `scripts/build-helper-macabi.sh` and
`scripts/inject-helper.sh` remain the canonical manual development commands.

The OpenClaw helper modifications are distributed with the plugin's MIT-licensed
source. Incorporated and adapted BlueBubbles, ZKSwizzle, and
CTObjectiveCRuntimeAdditions portions retain the licenses and notices in
`../THIRD_PARTY_NOTICES.md`.
