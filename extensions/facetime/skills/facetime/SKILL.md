---
name: facetime
description: "Inspect, open, attach to, and detach from an operator-confirmed FaceTime call through facetime_call."
metadata:
  { "openclaw": { "emoji": "📞", "requires": { "config": ["plugins.entries.facetime.enabled"] } } }
allowed-tools: facetime_call
---

# FaceTime

Use only `facetime_call`. Do not use shell commands or another call tool.

- `get_status` and `check_readiness` report internal stages only. Never infer
  remote identity, answer state, audibility, or video visibility from them.
- `initiate_call` opens FaceTime for the exact configured owner handle after
  one-shot approval. It does not prove the call connected.
- After the operator answers or confirms the call in FaceTime, use
  `attach_current_call` with the same configured owner handle. This requires a
  separate one-shot approval and starts OpenClaw media only after native route
  and process-owner proof succeeds.
- `end_call` detaches OpenClaw media. If it returns
  `manualHangupRequired: true`, say plainly that the carrier call must still be
  ended in FaceTime.
- Do not start or attach another call while an attachment exists.
- Never install/update/uninstall the driver, change SIP or developer-tools
  policy, grant permissions, edit `ownerHandles`, or operate System Settings.
