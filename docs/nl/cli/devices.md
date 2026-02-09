---
summary: "CLI-referentie voor `openclaw devices` (apparaatkoppeling + tokenrotatie/-intrekking)"
read_when:
  - Je keurt verzoeken voor apparaatkoppeling goed
  - Je moet apparaattokens roteren of intrekken
title: "apparaten"
---

# `openclaw devices`

Beheer verzoeken voor apparaatkoppeling en apparaatspecifieke tokens.

## Commands

### `openclaw devices list`

Toon openstaande koppelingsverzoeken en gekoppelde apparaten.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Keur een openstaand verzoek voor apparaatkoppeling goed.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Wijs een openstaand verzoek voor apparaatkoppeling af.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Roteer een apparaattoken voor een specifieke rol (optioneel met het bijwerken van scopes).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Trek een apparaattoken in voor een specifieke rol.

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway WebSocket-URL (standaard `gateway.remote.url` wanneer geconfigureerd).
- `--token <token>`: Gateway-token (indien vereist).
- `--password <password>`: Gateway-wachtwoord (wachtwoordauthenticatie).
- `--timeout <ms>`: RPC-time-out.
- `--json`: JSON-uitvoer (aanbevolen voor scripting).

Let op: wanneer je `--url` instelt, valt de CLI niet terug op config- of omgevingsreferenties.
Geef `--token` of `--password` expliciet door. Het ontbreken van expliciete referenties is een fout.

## Notes

- Tokenrotatie levert een nieuw token op (gevoelig). Behandel het als een geheim.
- Deze opdrachten vereisen de scope `operator.pairing` (of `operator.admin`).
