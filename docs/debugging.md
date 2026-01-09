---
summary: "Debugging tools: watch mode, raw model streams, and tracing reasoning leakage"
read_when:
  - You need to inspect raw model output for reasoning leakage
  - You want to run the Gateway in watch mode while iterating
  - You need a repeatable debugging workflow
---

# Debugging

This page covers debugging helpers for streaming output, especially when a
provider mixes reasoning into normal text.

## Gateway watch mode

For fast iteration, run the gateway under the file watcher:

```bash
pnpm gateway:watch --force
```

This maps to:

```bash
tsx watch src/entry.ts gateway --force
```

Add any gateway CLI flags after `gateway:watch` and they will be passed through
on each restart.

## Raw stream logging (Clawdbot)

Clawdbot can log the **raw assistant stream** before any filtering/formatting.
This is the best way to see whether reasoning is arriving as plain text deltas
(or as separate thinking blocks).

Enable it via CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Optional path override:

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.clawdbot/logs/raw-stream.jsonl
```

Equivalent env vars:

```bash
CLAWDBOT_RAW_STREAM=1
CLAWDBOT_RAW_STREAM_PATH=~/.clawdbot/logs/raw-stream.jsonl
```

Default file:

`~/.clawdbot/logs/raw-stream.jsonl`

## Raw chunk logging (pi-mono)

To capture **raw OpenAI-compat chunks** before they are parsed into blocks,
pi-mono exposes a separate logger:

```bash
PI_RAW_STREAM=1
```

Optional path:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Default file:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Note: this is only emitted by processes using pi-mono’s
> `openai-completions` provider.

## Safety notes

- Raw stream logs can include full prompts, tool output, and user data.
- Keep logs local and delete them after debugging.
- If you share logs, scrub secrets and PII first.
