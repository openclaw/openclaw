# Bug Report: Feishu Duplicate Reply Issue

**Date**: 2026-03-11
**OpenClaw Version**: 2026.3.8
**Feishu Plugin**: @openclaw/feishu 2026.3.7

## Problem

Users running Feishu channel experience duplicate replies — the same message receives 2-3 responses within 500-700ms.

Logs show `skipping duplicate message` is triggered but `deliver()` is still called afterwards:

```
2026-03-11T00:51:10.406Z [feishu] skipping duplicate message om_xxx (memory dedup)
2026-03-11T00:51:10.408Z [feishu] skipping duplicate message om_xxx
2026-03-11T00:51:11.077Z [feishu] feishu[default] deliver called  <- still executes
```

## Environment

- OS: Linux 6.8.0-90-generic x64
- Node.js: v22.22.0
- Model: deepv-easyclaw/kimi-k2.5
- Connection: WebSocket mode

## Analysis

After reviewing `bot.ts` lines 884-891, the dedup logic with `return` appears correct in isolation.
Possible root causes:

1. Feishu WebSocket reconnection delivering the same message through a different connection
2. Race condition between memory dedup (`accountId:messageId`) and persistent dedup (`messageId`)
3. Multiple concurrent WebSocket handlers processing same message before memory cache is populated

## Suggested Fix

Investigate whether duplicate replies occur specifically after WebSocket reconnection events.
Ensure both dedup layers are correctly synchronized under concurrent scenarios.
