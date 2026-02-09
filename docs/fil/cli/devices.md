---
summary: "Sanggunian ng CLI para sa `openclaw devices` (pagpapares ng device + pag-ikot/pagbawi ng token)"
read_when:
  - Ikaw ay nag-aapruba ng mga kahilingan sa pagpapares ng device
  - Kailangan mong mag-rotate o mag-revoke ng mga token ng device
title: "mga device"
---

# `openclaw devices`

Pamahalaan ang mga kahilingan sa pagpapares ng device at mga token na saklaw sa device.

## Mga command

### `openclaw devices list`

Ilista ang mga nakabinbing kahilingan sa pagpapares at mga naipares na device.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Aprubahan ang isang nakabinbing kahilingan sa pagpapares ng device.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Tanggihan ang isang nakabinbing kahilingan sa pagpapares ng device.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

I-rotate ang token ng device para sa isang partikular na role (opsyonal na ina-update ang mga scope).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

I-revoke ang token ng device para sa isang partikular na role.

```
openclaw devices revoke --device <deviceId> --role node
```

## Mga karaniwang opsyon

- `--url <url>`: Gateway WebSocket URL (default sa `gateway.remote.url` kapag naka-configure).
- `--token <token>`: Gateway token (kung kinakailangan).
- `--password <password>`: Gateway password (password auth).
- `--timeout <ms>`: RPC timeout.
- `--json`: JSON output (inirerekomenda para sa scripting).

5. Paalala: kapag itinakda mo ang `--url`, hindi na babalik ang CLI sa config o mga credential mula sa environment.
6. Ipasa nang tahasan ang `--token` o `--password`. 7. Ang kakulangan ng tahasang credential ay isang error.

## Mga tala

- 8. Ang token rotation ay nagbabalik ng bagong token (sensitibo). 9. Ituring ito bilang isang lihim.
- Kinakailangan ng mga command na ito ang `operator.pairing` (o `operator.admin`) scope.
