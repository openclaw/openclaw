---
summary: "CLI-referens för `openclaw devices` (enhetsparning + rotation/återkallning av token)"
read_when:
  - Du godkänner begäranden om enhetsparning
  - Du behöver rotera eller återkalla enhetstoken
title: "enheter"
x-i18n:
  source_path: cli/devices.md
  source_hash: ac7d130ecdc5d429
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:39Z
---

# `openclaw devices`

Hantera begäranden om enhetsparning och enhetsomfattade token.

## Kommandon

### `openclaw devices list`

Lista väntande parningsbegäranden och parade enheter.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Godkänn en väntande begäran om enhetsparning.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Avvisa en väntande begäran om enhetsparning.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotera en enhetstoken för en specifik roll (valfritt uppdatera scope).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Återkalla en enhetstoken för en specifik roll.

```
openclaw devices revoke --device <deviceId> --role node
```

## Vanliga alternativ

- `--url <url>`: Gateway WebSocket-URL (standard är `gateway.remote.url` när den är konfigurerad).
- `--token <token>`: Gateway-token (om det krävs).
- `--password <password>`: Gateway-lösenord (lösenordsautentisering).
- `--timeout <ms>`: RPC-timeout.
- `--json`: JSON-utdata (rekommenderas för skriptning).

Obs: när du anger `--url` faller CLI inte tillbaka till konfigurations- eller miljöautentiseringsuppgifter.
Skicka `--token` eller `--password` explicit. Avsaknad av explicita autentiseringsuppgifter är ett fel.

## Noteringar

- Tokenrotation returnerar en ny token (känslig). Behandla den som en hemlighet.
- Dessa kommandon kräver `operator.pairing`-scope (eller `operator.admin`).
