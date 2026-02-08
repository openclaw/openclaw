---
summary: "Webhook ingress para sa wake at mga hiwalay na agent run"
read_when:
  - Pagdaragdag o pagbabago ng mga webhook endpoint
  - Pagkonekta ng mga panlabas na system sa OpenClaw
title: "Mga Webhook"
x-i18n:
  source_path: automation/webhook.md
  source_hash: f26b88864567be82
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:28Z
---

# Mga Webhook

Maaaring mag-expose ang Gateway ng isang maliit na HTTP webhook endpoint para sa mga panlabas na trigger.

## Enable

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Mga tala:

- Kailangan ang `hooks.token` kapag `hooks.enabled=true`.
- Ang `hooks.path` ay default sa `/hooks`.

## Auth

Kailangang may hook token ang bawat request. Mas mainam gamitin ang headers:

- `Authorization: Bearer <token>` (inirerekomenda)
- `x-openclaw-token: <token>`
- `?token=<token>` (deprecated; nagla-log ng babala at aalisin sa susunod na major release)

## Mga Endpoint

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **kinakailangan** (string): Ang paglalarawan ng event (hal., "New email received").
- `mode` opsyonal (`now` | `next-heartbeat`): Kung magti-trigger ng agarang heartbeat (default `now`) o maghihintay sa susunod na periodic check.

Epekto:

- Nag-e-enqueue ng system event para sa **main** session
- Kapag `mode=now`, nagti-trigger ng agarang heartbeat

### `POST /hooks/agent`

Payload:

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **kinakailangan** (string): Ang prompt o mensahe na ipo-process ng agent.
- `name` opsyonal (string): Human-readable na pangalan para sa hook (hal., "GitHub"), ginagamit bilang prefix sa mga session summary.
- `sessionKey` opsyonal (string): Ang key na ginagamit para tukuyin ang session ng agent. Default sa isang random na `hook:<uuid>`. Ang paggamit ng pare-parehong key ay nagbibigay-daan sa multi-turn na pag-uusap sa loob ng hook context.
- `wakeMode` opsyonal (`now` | `next-heartbeat`): Kung magti-trigger ng agarang heartbeat (default `now`) o maghihintay sa susunod na periodic check.
- `deliver` opsyonal (boolean): Kapag `true`, ipapadala ang tugon ng agent sa messaging channel. Default sa `true`. Ang mga tugon na heartbeat acknowledgment lang ay awtomatikong nilalaktawan.
- `channel` opsyonal (string): Ang messaging channel para sa delivery. Isa sa: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Default sa `last`.
- `to` opsyonal (string): Ang recipient identifier para sa channel (hal., phone number para sa WhatsApp/Signal, chat ID para sa Telegram, channel ID para sa Discord/Slack/Mattermost (plugin), conversation ID para sa MS Teams). Default sa huling recipient sa main session.
- `model` opsyonal (string): Model override (hal., `anthropic/claude-3-5-sonnet` o isang alias). Dapat ay nasa allowed model list kung may restriction.
- `thinking` opsyonal (string): Thinking level override (hal., `low`, `medium`, `high`).
- `timeoutSeconds` opsyonal (number): Maximum na tagal para sa agent run sa segundo.

Epekto:

- Tumatakbo ng isang **hiwalay** na agent turn (sariling session key)
- Palaging nagpo-post ng summary sa **main** session
- Kapag `wakeMode=now`, nagti-trigger ng agarang heartbeat

### `POST /hooks/<name>` (mapped)

Nireresolba ang mga custom hook name sa pamamagitan ng `hooks.mappings` (tingnan ang configuration). Ang isang mapping ay maaaring
mag-convert ng arbitrary payloads papunta sa mga aksyong `wake` o `agent`, na may opsyonal na mga template o
code transform.

Mga opsyon sa mapping (buod):

- Pinapagana ng `hooks.presets: ["gmail"]` ang built-in na Gmail mapping.
- Hinahayaan ka ng `hooks.mappings` na magtakda ng `match`, `action`, at mga template sa config.
- Ang `hooks.transformsDir` + `transform.module` ay naglo-load ng JS/TS module para sa custom na logic.
- Gamitin ang `match.source` para panatilihin ang isang generic ingest endpoint (payload-driven routing).
- Ang mga TS transform ay nangangailangan ng TS loader (hal., `bun` o `tsx`) o precompiled na `.js` sa runtime.
- Itakda ang `deliver: true` + `channel`/`to` sa mga mapping para i-route ang mga reply sa isang chat surface
  (`channel` ay default sa `last` at nagfa-fallback sa WhatsApp).
- Dinidi-disable ng `allowUnsafeExternalContent: true` ang external content safety wrapper para sa hook na iyon
  (mapanganib; para lang sa mga pinagkakatiwalaang internal source).
- Isinusulat ng `openclaw webhooks gmail setup` ang `hooks.gmail` config para sa `openclaw webhooks gmail run`.
  Tingnan ang [Gmail Pub/Sub](/automation/gmail-pubsub) para sa buong Gmail watch flow.

## Mga Tugon

- `200` para sa `/hooks/wake`
- `202` para sa `/hooks/agent` (nagsimula ang async run)
- `401` kapag auth failure
- `400` kapag invalid ang payload
- `413` kapag oversized ang payload

## Mga Halimbawa

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Gumamit ng ibang model

Idagdag ang `model` sa agent payload (o mapping) para i-override ang model para sa run na iyon:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

Kung ipinapatupad mo ang `agents.defaults.models`, tiyaking kasama roon ang override model.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Seguridad

- Panatilihin ang mga hook endpoint sa likod ng loopback, tailnet, o pinagkakatiwalaang reverse proxy.
- Gumamit ng dedikadong hook token; huwag i-reuse ang mga gateway auth token.
- Iwasang magsama ng sensitibong raw payload sa mga webhook log.
- Ang mga hook payload ay itinuturing na hindi pinagkakatiwalaan at binalot ng mga safety boundary bilang default.
  Kung kailangan mong i-disable ito para sa isang partikular na hook, itakda ang `allowUnsafeExternalContent: true`
  sa mapping ng hook na iyon (mapanganib).
