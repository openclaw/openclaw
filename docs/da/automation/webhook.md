---
summary: "Webhook‑indgang til wake og isolerede agentkørsler"
read_when:
  - Tilføjelse eller ændring af webhook‑endpoints
  - Sammenkobling af eksterne systemer med OpenClaw
title: "Webhooks"
x-i18n:
  source_path: automation/webhook.md
  source_hash: f26b88864567be82
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:00Z
---

# Webhooks

Gateway kan eksponere et lille HTTP‑webhook‑endpoint til eksterne triggere.

## Aktiver

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Noter:

- `hooks.token` er påkrævet, når `hooks.enabled=true`.
- `hooks.path` har som standard værdien `/hooks`.

## Autentificering

Hver anmodning skal inkludere hook‑tokenet. Foretræk headers:

- `Authorization: Bearer <token>` (anbefalet)
- `x-openclaw-token: <token>`
- `?token=<token>` (forældet; logger en advarsel og fjernes i en fremtidig hovedudgivelse)

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **påkrævet** (string): Beskrivelsen af hændelsen (f.eks. "Ny e‑mail modtaget").
- `mode` valgfri (`now` | `next-heartbeat`): Om der skal udløses et øjeblikkeligt heartbeat (standard `now`) eller ventes til næste periodiske check.

Effekt:

- Sætter en systemhændelse i kø for **hoved**‑sessionen
- Hvis `mode=now`, udløses et øjeblikkeligt heartbeat

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

- `message` **påkrævet** (string): Prompten eller beskeden, som agenten skal behandle.
- `name` valgfri (string): Menneskeligt læsbart navn for hooken (f.eks. "GitHub"), bruges som præfiks i sessionsammendrag.
- `sessionKey` valgfri (string): Nøglen, der bruges til at identificere agentens session. Standard er en tilfældig `hook:<uuid>`. Brug af en konsistent nøgle muliggør en flerturns‑samtale inden for hook‑konteksten.
- `wakeMode` valgfri (`now` | `next-heartbeat`): Om der skal udløses et øjeblikkeligt heartbeat (standard `now`) eller ventes til næste periodiske check.
- `deliver` valgfri (boolean): Hvis `true`, sendes agentens svar til beskedkanalen. Standard er `true`. Svar, der kun er heartbeat‑kvitteringer, springes automatisk over.
- `channel` valgfri (string): Beskedkanalen til levering. En af: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Standard er `last`.
- `to` valgfri (string): Modtager‑identifikator for kanalen (f.eks. telefonnummer for WhatsApp/Signal, chat‑ID for Telegram, kanal‑ID for Discord/Slack/Mattermost (plugin), samtale‑ID for MS Teams). Standard er den seneste modtager i hovedsessionen.
- `model` valgfri (string): Model‑override (f.eks. `anthropic/claude-3-5-sonnet` eller et alias). Skal være på listen over tilladte modeller, hvis der er begrænsninger.
- `thinking` valgfri (string): Override af tænkeniveau (f.eks. `low`, `medium`, `high`).
- `timeoutSeconds` valgfri (number): Maksimal varighed for agentkørslen i sekunder.

Effekt:

- Kører en **isoleret** agenttur (egen sessionsnøgle)
- Poster altid et sammendrag i **hoved**‑sessionen
- Hvis `wakeMode=now`, udløses et øjeblikkeligt heartbeat

### `POST /hooks/<name>` (mapped)

Brugerdefinerede hook‑navne slås op via `hooks.mappings` (se konfiguration). En mapping kan
omdanne vilkårlige payloads til `wake`‑ eller `agent`‑handlinger med valgfrie skabeloner eller
kode‑transforms.

Mapping‑muligheder (overblik):

- `hooks.presets: ["gmail"]` aktiverer den indbyggede Gmail‑mapping.
- `hooks.mappings` lader dig definere `match`, `action` og skabeloner i konfigurationen.
- `hooks.transformsDir` + `transform.module` indlæser et JS/TS‑modul til brugerdefineret logik.
- Brug `match.source` for at beholde et generisk ingest‑endpoint (payload‑drevet routing).
- TS‑transforms kræver en TS‑loader (f.eks. `bun` eller `tsx`) eller forkompileret `.js` ved runtime.
- Sæt `deliver: true` + `channel`/`to` på mappings for at route svar til en chat‑overflade
  (`channel` har som standard `last` og falder tilbage til WhatsApp).
- `allowUnsafeExternalContent: true` deaktiverer den eksterne indpakning for indholdssikkerhed for den hook
  (farligt; kun til betroede interne kilder).
- `openclaw webhooks gmail setup` skriver `hooks.gmail`‑konfiguration for `openclaw webhooks gmail run`.
  Se [Gmail Pub/Sub](/automation/gmail-pubsub) for det fulde Gmail‑watch‑flow.

## Svar

- `200` for `/hooks/wake`
- `202` for `/hooks/agent` (asynkron kørsel startet)
- `401` ved autentificeringsfejl
- `400` ved ugyldig payload
- `413` ved for store payloads

## Eksempler

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

### Brug en anden model

Tilføj `model` til agent‑payloaden (eller mappingen) for at override modellen for den kørsel:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

Hvis du håndhæver `agents.defaults.models`, skal du sikre, at override‑modellen er inkluderet dér.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Sikkerhed

- Hold hook‑endpoints bag loopback, tailnet eller en betroet reverse proxy.
- Brug et dedikeret hook‑token; genbrug ikke gateway‑autentificeringstokens.
- Undgå at inkludere følsomme rå payloads i webhook‑logs.
- Hook‑payloads behandles som utroværdige og indpakkes som standard med sikkerhedsgrænser.
  Hvis du absolut skal deaktivere dette for en specifik hook, så sæt `allowUnsafeExternalContent: true`
  i den hooks mapping (farligt).
