---
summary: "Webhook-ingång för väckning och isolerade agentkörningar"
read_when:
  - Lägga till eller ändra webhook-slutpunkter
  - Koppla externa system till OpenClaw
title: "Webhooks"
x-i18n:
  source_path: automation/webhook.md
  source_hash: f26b88864567be82
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:20Z
---

# Webhooks

Gateway (nätverksgateway) kan exponera en liten HTTP-webhook-slutpunkt för externa triggers.

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

Noteringar:

- `hooks.token` krävs när `hooks.enabled=true`.
- `hooks.path` är som standard `/hooks`.

## Auth

Varje begäran måste inkludera hook-token. Föredra headers:

- `Authorization: Bearer <token>` (rekommenderas)
- `x-openclaw-token: <token>`
- `?token=<token>` (föråldrad; loggar en varning och tas bort i en framtida huvudversion)

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **krävs** (string): Beskrivningen av händelsen (t.ex. "New email received").
- `mode` valfri (`now` | `next-heartbeat`): Om ett omedelbart heartbeat ska triggas (standard `now`) eller om man ska vänta till nästa periodiska kontroll.

Effekt:

- Köar en systemhändelse för **huvud**-sessionen
- Om `mode=now`, triggar ett omedelbart heartbeat

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

- `message` **krävs** (string): Prompten eller meddelandet som agenten ska bearbeta.
- `name` valfri (string): Mänskligt läsbart namn för hooken (t.ex. "GitHub"), används som prefix i sessionssammanfattningar.
- `sessionKey` valfri (string): Nyckeln som används för att identifiera agentens session. Standard är en slumpmässig `hook:<uuid>`. Att använda en konsekvent nyckel möjliggör en flerturns-konversation inom hook-kontexten.
- `wakeMode` valfri (`now` | `next-heartbeat`): Om ett omedelbart heartbeat ska triggas (standard `now`) eller om man ska vänta till nästa periodiska kontroll.
- `deliver` valfri (boolean): Om `true` skickas agentens svar till meddelandekanalen. Standard är `true`. Svar som endast är heartbeat-bekräftelser hoppas automatiskt över.
- `channel` valfri (string): Meddelandekanal för leverans. En av: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Standard är `last`.
- `to` valfri (string): Mottagaridentifierare för kanalen (t.ex. telefonnummer för WhatsApp/Signal, chatt-ID för Telegram, kanal-ID för Discord/Slack/Mattermost (plugin), konversations-ID för MS Teams). Standard är senaste mottagaren i huvudsessionen.
- `model` valfri (string): Modell-override (t.ex. `anthropic/claude-3-5-sonnet` eller ett alias). Måste finnas i listan över tillåtna modeller om begränsad.
- `thinking` valfri (string): Override för tänkenivå (t.ex. `low`, `medium`, `high`).
- `timeoutSeconds` valfri (number): Maximal varaktighet för agentkörningen i sekunder.

Effekt:

- Kör en **isolerad** agentturn (egen sessionsnyckel)
- Postar alltid en sammanfattning i **huvud**-sessionen
- Om `wakeMode=now`, triggar ett omedelbart heartbeat

### `POST /hooks/<name>` (mappad)

Anpassade hook-namn löses via `hooks.mappings` (se konfiguration). En mappning kan
omvandla godtyckliga payloads till `wake`- eller `agent`-åtgärder, med valfria mallar eller
kodtransformationer.

Mappningsalternativ (sammanfattning):

- `hooks.presets: ["gmail"]` aktiverar den inbyggda Gmail-mappningen.
- `hooks.mappings` låter dig definiera `match`, `action` och mallar i konfig.
- `hooks.transformsDir` + `transform.module` laddar en JS/TS-modul för anpassad logik.
- Använd `match.source` för att behålla en generisk ingest-slutpunkt (payload-driven routing).
- TS-transformationer kräver en TS-loader (t.ex. `bun` eller `tsx`) eller förkompilerad `.js` vid körning.
- Sätt `deliver: true` + `channel`/`to` på mappningar för att routa svar till en chattyta
  (`channel` är som standard `last` och faller tillbaka till WhatsApp).
- `allowUnsafeExternalContent: true` inaktiverar den externa innehållssäkerhetsomslutningen för den hooken
  (farligt; endast för betrodda interna källor).
- `openclaw webhooks gmail setup` skriver `hooks.gmail`-konfig för `openclaw webhooks gmail run`.
  Se [Gmail Pub/Sub](/automation/gmail-pubsub) för hela Gmail watch-flödet.

## Responses

- `200` för `/hooks/wake`
- `202` för `/hooks/agent` (asynkron körning startad)
- `401` vid autentiseringsfel
- `400` vid ogiltig payload
- `413` vid för stora payloads

## Examples

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

### Use a different model

Lägg till `model` i agent-payloaden (eller mappningen) för att åsidosätta modellen för den körningen:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

Om du tillämpar `agents.defaults.models`, se till att override-modellen ingår där.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Security

- Håll hook-slutpunkter bakom loopback, tailnet eller betrodd reverse proxy.
- Använd en dedikerad hook-token; återanvänd inte gateway-autentiseringstokens.
- Undvik att inkludera känsliga råa payloads i webhook-loggar.
- Hook-payloads behandlas som opålitliga och omsluts som standard av säkerhetsgränser.
  Om du måste inaktivera detta för en specifik hook, sätt `allowUnsafeExternalContent: true`
  i den hookens mappning (farligt).
