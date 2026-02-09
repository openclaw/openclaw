---
summary: "CLI-referens för `openclaw devices` (enhetsparning + rotation/återkallning av token)"
read_when:
  - Du godkänner begäranden om enhetsparning
  - Du behöver rotera eller återkalla enhetstoken
title: "enheter"
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

Notera: När du anger `--url`, faller CLI inte tillbaka till config eller miljöuppgifter.
Passera `--token` eller` --lösenord` explicit. Saknar explicita referenser är ett fel.

## Noteringar

- Token rotation returnerar en ny token (känslig). Behandla det som en hemlighet.
- Dessa kommandon kräver `operator.pairing`-scope (eller `operator.admin`).
