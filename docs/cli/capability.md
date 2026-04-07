---
summary: "Infer-first CLI for provider-backed model, image, audio, TTS, video, web, and embedding workflows"
read_when:
  - Adding or modifying `openclaw infer` commands
  - Designing stable headless capability automation
title: "Inference CLI"
---

# Inference CLI

`openclaw infer` is the canonical headless surface for provider-backed inference workflows.

`openclaw capability` remains supported as a fallback alias for compatibility.

It intentionally exposes capability families, not raw gateway RPC names and not raw agent tool ids.

## Command tree

```text
 openclaw infer
  list
  inspect

  model
    run
    list
    inspect
    providers
    auth login
    auth logout
    auth status

  image
    generate
    edit
    describe
    describe-many
    providers

  audio
    transcribe
    providers

  tts
    convert
    voices
    providers
    status
    enable
    disable
    set-provider

  video
    generate
    describe
    providers

  web
    search
    fetch
    providers

  embedding
    create
    providers
```

## Transport

Supported transport flags:

- `--local`
- `--gateway`

Default transport is implicit auto at the command-family level:

- Stateless execution commands default to local.
- Gateway-managed state commands default to gateway.

Examples:

```bash
openclaw infer model run --prompt "hello" --json
openclaw infer image generate --prompt "friendly lobster" --json
openclaw infer tts status --json
openclaw infer embedding create --text "hello world" --json
```

## JSON output

Capability commands normalize JSON output under a shared envelope:

```json
{
  "ok": true,
  "capability": "image.generate",
  "transport": "local",
  "provider": "openai",
  "model": "gpt-image-1",
  "attempts": [],
  "outputs": []
}
```

Top-level fields are stable:

- `ok`
- `capability`
- `transport`
- `provider`
- `model`
- `attempts`
- `outputs`
- `error`

## Notes

- `model run` reuses the agent runtime so provider/model overrides behave like normal agent execution.
- `tts status` defaults to gateway because it reflects gateway-managed TTS state.
