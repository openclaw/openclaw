---
summary: "Mga global na voice wake word (pagmamay-ari ng Gateway) at kung paano sila nagsi-sync sa lahat ng node"
read_when:
  - Binabago ang behavior o mga default ng voice wake words
  - Nagdaragdag ng mga bagong node platform na nangangailangan ng wake word sync
title: "Voice Wake"
---

# Voice Wake (Mga Global Wake Word)

Tinatrato ng OpenClaw ang **wake words bilang iisang global na listahan** na pagmamay-ari ng **Gateway**.

- **Walang per-node na custom wake words**.
- **Anumang node/app UI ay maaaring mag-edit** ng listahan; ang mga pagbabago ay sine-save ng Gateway at ibino-broadcast sa lahat.
- Bawat device ay may sarili pa ring **Voice Wake enabled/disabled** toggle (magkakaiba ang lokal na UX + mga pahintulot).

## Storage (host ng Gateway)

Ang mga wake word ay naka-store sa gateway machine sa:

- `~/.openclaw/settings/voicewake.json`

Hugis:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protocol

### Mga Method

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` na may params `{ triggers: string[] }` → `{ triggers: string[] }`

Mga tala:

- Ang mga trigger ay nino‑normalize (tinatabas, inaalis ang mga walang laman). Ang mga walang lamang listahan ay bumabalik sa mga default.
- May ipinapatupad na mga limit para sa kaligtasan (mga cap sa bilang/haba).

### Mga Event

- `voicewake.changed` payload `{ triggers: string[] }`

Sino ang tumatanggap nito:

- Lahat ng WebSocket client (macOS app, WebChat, atbp.)
- Lahat ng nakakonektang node (iOS/Android), at ipinapadala rin sa pag-connect ng node bilang paunang “current state” push.

## Behavior ng client

### macOS app

- Ginagamit ang global na listahan para i-gate ang mga `VoiceWakeRuntime` trigger.
- Ang pag-edit ng “Trigger words” sa mga setting ng Voice Wake ay tumatawag sa `voicewake.set` at pagkatapos ay umaasa sa broadcast para panatilihing naka-sync ang ibang mga client.

### iOS node

- Ginagamit ang global na listahan para sa `VoiceWakeManager` trigger detection.
- Ang pag-edit ng Wake Words sa Settings ay tumatawag sa `voicewake.set` (sa Gateway WS) at pinananatiling responsive ang lokal na wake-word detection.

### Android node

- Nag-e-expose ng Wake Words editor sa Settings.
- Tumatawag sa `voicewake.set` sa Gateway WS para mag-sync ang mga edit sa lahat.
