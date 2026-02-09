---
summary: "CLI-reference for `openclaw devices` (enhedsparring + tokenrotation/tilbagekaldelse)"
read_when:
  - Du godkender anmodninger om enhedsparring
  - Du skal rotere eller tilbagekalde enhedstokens
title: "enheder"
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

Bemærk: Når du angiver `--url`, falder CLI ikke tilbage til config eller miljø legitimationsoplysninger.
Pass `--token` eller `--password` eksplicitt. Manglende eksplicitte legitimationsoplysninger er en fejl.

## Noter

- Token rotation giver en ny token (følsom). Behandl det som en hemmelighed.
- Disse kommandoer kræver `operator.pairing`- (eller `operator.admin`-) scope.
