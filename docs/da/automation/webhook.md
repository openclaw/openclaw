---
summary: "Webhook‑indgang til wake og isolerede agentkørsler"
read_when:
  - Tilføjelse eller ændring af webhook‑endpoints
  - Sammenkobling af eksterne systemer med OpenClaw
title: "Webhooks"
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

Hver anmodning skal indeholde krog token. Foretræk headers:

- `Authorization: Bearer <token>` (anbefalet)
- `x-openclaw-token: <token>`
- `?token=<token>` (forældet; logger en advarsel og fjernes i en fremtidig hovedudgivelse)

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **obligatorisk** (streng): Beskrivelse af begivenheden (f.eks. "Ny e-mail modtaget").
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
- `name` valgfri (streng): Menneskelæseligt navn for krogen (f.eks. "GitHub"), brugt som præfiks i sessionsoversigter.
- `sessionKey` valgfri (streng): Den nøgle, der bruges til at identificere agentens session. Standard er en tilfældig `hook:<uuid>`. Brug af en konsekvent nøgle giver mulighed for en multi-turn samtale inden for krog konteksten.
- `wakeMode` valgfri (`now` | `next-heartbeat`): Om der skal udløses et øjeblikkeligt heartbeat (standard `now`) eller ventes til næste periodiske check.
- `deliver` valgfri (boolesk): Hvis `true`, agenten svar vil blive sendt til meddelelseskanalen. Standard er `sand`. Reaktioner, der kun er hjerteslag anerkendelser automatisk springes over.
- `kanal` valgfri (streng): Meddelelseskanalen til levering. En af: `sidste`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Standard til `sidste`.
- `til` valgfri (streng): Modtagerens identifikator for kanalen (f.eks. telefonnummer til WhatsApp/Signal, chat-id til Telegram, kanal-id til Discord/Slack/Mattermost (plugin), samtale-id til MS Teams). Standard er den sidste modtager i hovedsessionen.
- `model` valgfri (streng): Model tilsidesætte (f.eks. `antropic/claude-3-5-sonnet` eller et alias). Skal være i den tilladte model liste, hvis begrænset.
- `thinking` valgfri (streng): Tænkning niveau tilsidesætte (fx, `low`, `medium`, `high`).
- `timeoutSeconds` valgfri (number): Maksimal varighed for agentkørslen i sekunder.

Effekt:

- Kører en **isoleret** agenttur (egen sessionsnøgle)
- Poster altid et sammendrag i **hoved**‑sessionen
- Hvis `wakeMode=now`, udløses et øjeblikkeligt heartbeat

### `POST /hooks/<name>` (mapped)

Brugerdefinerede krognavne løses via `hooks.mappings` (se konfiguration). En kortlægning kan
gøre vilkårlige nyttelast til 'wake' eller 'agent' handlinger, med valgfri skabeloner eller
kode transformer.

Mapping‑muligheder (overblik):

- `hooks.presets: ["gmail"]` aktiverer den indbyggede Gmail‑mapping.
- `hooks.mappings` lader dig definere `match`, `action` og skabeloner i konfigurationen.
- `hooks.transformsDir` + `transform.module` indlæser et JS/TS‑modul til brugerdefineret logik.
- Brug `match.source` for at beholde et generisk ingest‑endpoint (payload‑drevet routing).
- TS transformerer kræver en TS-læsser (f.eks. `bun` eller `tsx`) eller forkompileret `.js` under runtime.
- Sæt `deliver: true` + `channel`/`to` på mappings for at route svar til en chat‑overflade
  (`channel` har som standard `last` og falder tilbage til WhatsApp).
- `allowUnsafeExternalContent: true` deaktiverer den eksterne indpakning for indholdssikkerhed for den hook
  (farligt; kun til betroede interne kilder).
- `openclaw webhooks gmail setup` skriver `hooks.gmail` config for `openclaw webhooks gmail run`.
  Se [Gmail Pub/Sub](/automation/gmail-pubsub) for det fulde Gmail ur flow.

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
- Hook nyttelast behandles som ubetroet og indpakket med sikkerhedsgrænser som standard.
  Hvis du skal deaktivere dette for en bestemt krog, sæt `allowUnsafeExternalContent: true`
  i at krogens kortlægning (farligt).
