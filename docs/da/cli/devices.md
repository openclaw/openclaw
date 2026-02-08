---
summary: "CLI-reference for `openclaw devices` (enhedsparring + tokenrotation/tilbagekaldelse)"
read_when:
  - Du godkender anmodninger om enhedsparring
  - Du skal rotere eller tilbagekalde enhedstokens
title: "enheder"
x-i18n:
  source_path: cli/devices.md
  source_hash: ac7d130ecdc5d429
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:57Z
---

# `openclaw devices`

Administrér anmodninger om enhedsparring og enhedsspecifikke tokens.

## Kommandoer

### `openclaw devices list`

Vis ventende parringsanmodninger og parrede enheder.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Godkend en ventende anmodning om enhedsparring.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Afvis en ventende anmodning om enhedsparring.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotér et enhedstoken for en bestemt rolle (valgfrit med opdatering af scopes).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Tilbagekald et enhedstoken for en bestemt rolle.

```
openclaw devices revoke --device <deviceId> --role node
```

## Fælles indstillinger

- `--url <url>`: Gateway WebSocket-URL (standard er `gateway.remote.url`, når den er konfigureret).
- `--token <token>`: Gateway-token (hvis påkrævet).
- `--password <password>`: Gateway-adgangskode (adgangskodeautentificering).
- `--timeout <ms>`: RPC-timeout.
- `--json`: JSON-output (anbefalet til scripting).

Bemærk: Når du angiver `--url`, falder CLI ikke tilbage til konfiguration eller legitimationsoplysninger fra miljøet.
Angiv `--token` eller `--password` eksplicit. Manglende eksplicitte legitimationsoplysninger er en fejl.

## Noter

- Tokenrotation returnerer et nyt token (følsomt). Behandl det som en hemmelighed.
- Disse kommandoer kræver `operator.pairing`- (eller `operator.admin`-) scope.
