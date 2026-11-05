---
summary: "CLI reference for `openclaw clawbot` (legacy alias namespace)"
read_when:
  - You maintain older scripts using `openclaw clawbot ...`
  - You need migration guidance to current commands
title: "Clawbot"
---

# `openclaw clawbot`

Legacy alias namespace kept for backward compatibility. It registers the same QR command as the top-level CLI, so `openclaw clawbot qr` accepts every [`openclaw qr`](/cli/qr) flag. No removal is scheduled; prefer the top-level commands in new scripts.

## Migration

Prefer the modern top-level command:

- `openclaw clawbot qr` -> `openclaw qr`

## Related

- [CLI reference](/cli)
