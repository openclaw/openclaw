---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Telegram allowlist hardening: prefix + whitespace normalization"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Reviewing historical Telegram allowlist changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Telegram Allowlist Hardening"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Telegram Allowlist Hardening（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Date**: 2026-01-05  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Status**: Complete  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**PR**: #216（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Telegram allowlists now accept `telegram:` and `tg:` prefixes case-insensitively, and tolerate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
accidental whitespace. This aligns inbound allowlist checks with outbound send normalization.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What changed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefixes `telegram:` and `tg:` are treated the same (case-insensitive).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Allowlist entries are trimmed; empty entries are ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All of these are accepted for the same ID:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `telegram:123456`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `TG:123456`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tg:123456`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why it matters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Copy/paste from logs or chat IDs often includes prefixes and whitespace. Normalizing avoids（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
false negatives when deciding whether to respond in DMs or groups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Group Chats](/channels/groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Telegram Provider](/channels/telegram)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
