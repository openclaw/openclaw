---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Global voice wake words (Gateway-owned) and how they sync across nodes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing voice wake words behavior or defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding new node platforms that need wake word sync（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Voice Wake"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Voice Wake (Global Wake Words)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw treats **wake words as a single global list** owned by the **Gateway**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- There are **no per-node custom wake words**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Any node/app UI may edit** the list; changes are persisted by the Gateway and broadcast to everyone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each device still keeps its own **Voice Wake enabled/disabled** toggle (local UX + permissions differ).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Storage (Gateway host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wake words are stored on the gateway machine at:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/settings/voicewake.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shape:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Protocol（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Methods（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicewake.get` → `{ triggers: string[] }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicewake.set` with params `{ triggers: string[] }` → `{ triggers: string[] }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Triggers are normalized (trimmed, empties dropped). Empty lists fall back to defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Limits are enforced for safety (count/length caps).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Events（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicewake.changed` payload `{ triggers: string[] }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Who receives it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All WebSocket clients (macOS app, WebChat, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All connected nodes (iOS/Android), and also on node connect as an initial “current state” push.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Client behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### macOS app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses the global list to gate `VoiceWakeRuntime` triggers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Editing “Trigger words” in Voice Wake settings calls `voicewake.set` and then relies on the broadcast to keep other clients in sync.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### iOS node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses the global list for `VoiceWakeManager` trigger detection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Editing Wake Words in Settings calls `voicewake.set` (over the Gateway WS) and also keeps local wake-word detection responsive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Android node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exposes a Wake Words editor in Settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Calls `voicewake.set` over the Gateway WS so edits sync everywhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
