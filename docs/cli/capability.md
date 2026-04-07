---
summary: "Infer-first CLI for provider-backed model, image, audio, TTS, video, web, and embedding workflows"
read_when:
  - Adding or modifying `openclaw infer` commands
  - Designing stable headless capability automation
title: "Inference CLI"
---

# Inference CLI

`openclaw infer` is the canonical headless surface for provider-backed inference workflows.

It intentionally exposes capability families, not raw gateway RPC names and not raw agent tool ids.

## Common tasks

This table maps common inference tasks to the corresponding infer command.

| If the user wants to...         | Use this command                                                       |
| ------------------------------- | ---------------------------------------------------------------------- |
| run a text/model prompt         | `openclaw infer model run --prompt "..." --json`                       |
| list configured model providers | `openclaw infer model providers --json`                                |
| generate an image               | `openclaw infer image generate --prompt "..." --json`                  |
| describe an image file          | `openclaw infer image describe --file ./image.png --json`              |
| transcribe audio                | `openclaw infer audio transcribe --file ./memo.m4a --json`             |
| synthesize speech               | `openclaw infer tts convert --text "..." --output ./speech.mp3 --json` |
| generate a video                | `openclaw infer video generate --prompt "..." --json`                  |
| describe a video file           | `openclaw infer video describe --file ./clip.mp4 --json`               |
| search the web                  | `openclaw infer web search --query "..." --json`                       |
| fetch a web page                | `openclaw infer web fetch --url https://example.com --json`            |
| create embeddings               | `openclaw infer embedding create --text "..." --json`                  |

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

## Examples

These examples show the standard command shape across the infer surface.

```bash
openclaw infer list --json
openclaw infer inspect --name image.generate --json
openclaw infer model run --prompt "Reply with exactly: smoke-ok" --json
openclaw infer model providers --json
openclaw infer image generate --prompt "friendly lobster illustration" --json
openclaw infer image describe --file ./photo.jpg --json
openclaw infer audio transcribe --file ./memo.m4a --json
openclaw infer tts convert --text "hello from openclaw" --output ./hello.mp3 --json
openclaw infer video generate --prompt "cinematic sunset over the ocean" --json
openclaw infer video describe --file ./clip.mp4 --json
openclaw infer web search --query "OpenClaw docs" --json
openclaw infer embedding create --text "friendly lobster" --json
```

## Additional examples

```bash
openclaw infer audio transcribe --file ./team-sync.m4a --language en --prompt "Focus on names and action items" --json
openclaw infer image describe --file ./ui-screenshot.png --model openai/gpt-4.1-mini --json
openclaw infer tts convert --text "Your build is complete" --output ./build-complete.mp3 --json
openclaw infer web search --query "OpenClaw docs infer web providers" --json
openclaw infer embedding create --text "customer support ticket: delayed shipment" --model openai/text-embedding-3-large --json
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

## Usage notes

- `openclaw infer ...` is the primary CLI surface for these workflows.
- Use `--json` when the output will be consumed by another command or script.
- Use `--provider` or `--model provider/model` when a specific backend is required.
- For `image describe`, `audio transcribe`, and `video describe`, `--model` must use the form `<provider/model>`.
- The normal local path does not require the gateway to be running.

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

## Common pitfalls

```bash
# Bad
openclaw infer media image generate --prompt "friendly lobster"

# Good
openclaw infer image generate --prompt "friendly lobster"
```

```bash
# Bad
openclaw infer audio transcribe --file ./memo.m4a --model whisper-1 --json

# Good
openclaw infer audio transcribe --file ./memo.m4a --model openai/whisper-1 --json
```

## Notes

- `model run` reuses the agent runtime so provider/model overrides behave like normal agent execution.
- `tts status` defaults to gateway because it reflects gateway-managed TTS state.
- `openclaw capability ...` is an alias for `openclaw infer ...`.
