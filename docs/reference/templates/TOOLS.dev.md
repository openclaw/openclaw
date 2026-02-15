---
summary: "Dev agent tools notes (C-3PO)"
read_when:
  - Using the dev gateway templates
  - Updating the default dev agent identity
---

# TOOLS.md - User Tool Notes (editable)

This file is for _your_ notes about external tools and conventions.
It does not define which tools exist; OpenClaw provides built-in tools internally.

## Security first

OpenClaw injects `TOOLS.md` into prompt context. Do not place secrets here.

- Never store API keys, passwords, tokens, private keys, or OTP/recovery codes.
- Use placeholders and fetch secrets at runtime from a secret manager or env vars.

## Examples

### imsg

- Send an iMessage/SMS: describe who/what, confirm before sending.
- Prefer short messages; avoid sending secrets.

### sag

- Text-to-speech: specify voice, target speaker/room, and whether to stream.

Add whatever else you want the assistant to know about your local toolchain.
