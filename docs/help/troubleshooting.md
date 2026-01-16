---
summary: "Troubleshooting hub: symptoms → checks → fixes"
read_when:
  - You see an error and want the fix path
  - The installer says “success” but the CLI doesn’t work
---

# Troubleshooting

## First 60 seconds

Run these in order:

```bash
clawdbot status
clawdbot status --all
clawdbot daemon status
clawdbot logs --follow
clawdbot doctor
```

If the gateway is reachable, deep probes:

```bash
clawdbot status --deep
```

## Common “it broke” cases

### `clawdbot: command not found`

Almost always a Node/npm PATH issue. Start here:

- [Install (Node/npm PATH sanity)](/install#nodejs--npm-path-sanity)

### Gateway “unauthorized”, can’t connect, or keeps reconnecting

- [Gateway troubleshooting](/gateway/troubleshooting)
- [Gateway authentication](/gateway/authentication)

### Daemon says running, but RPC probe fails

- [Gateway troubleshooting](/gateway/troubleshooting)
- [Background process / daemon](/gateway/background-process)

### Model/auth failures (rate limit, billing, “all models failed”)

- [Models](/cli/models)
- [OAuth / auth concepts](/concepts/oauth)

### When filing an issue

Paste a safe report:

```bash
clawdbot status --all
```

If you can, include the relevant log tail from `clawdbot logs --follow`.
