---
summary: "Sanggunian ng CLI para sa `openclaw node` (headless na host ng node)"
read_when:
  - Pinapatakbo ang headless na host ng node
  - Pag-pair ng non-macOS na node para sa system.run
title: "node"
---

# `openclaw node`

Magpatakbo ng **headless na host ng node** na kumokonekta sa Gateway WebSocket at naglalantad ng
`system.run` / `system.which` sa makinang ito.

## Bakit gagamit ng host ng node?

Gumamit ng host ng node kapag gusto mong ang mga agent ay **magpatakbo ng mga command sa ibang mga makina** sa iyong
network nang hindi nag-i-install ng buong macOS companion app doon.

Mga karaniwang use case:

- Magpatakbo ng mga command sa mga remote na Linux/Windows box (build servers, lab machines, NAS).
- Panatilihing **sandboxed** ang exec sa gateway, pero italaga ang mga aprubadong run sa ibang mga host.
- Magbigay ng magaan, headless na execution target para sa automation o CI nodes.

Ang execution ay binabantayan pa rin ng **exec approvals** at mga allowlist kada agent sa
host ng node, kaya nananatiling naka-scope at explicit ang access sa mga command.

## Browser proxy (zero-config)

Awtomatikong ina-advertise ng mga node host ang isang browser proxy kung ang `browser.enabled` ay hindi naka-disable sa node. Pinapahintulutan nito ang agent na gumamit ng browser automation sa node na iyon
nang walang karagdagang configuration.

I-disable ito sa node kung kinakailangan:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Patakbuhin (foreground)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Mga opsyon:

- `--host <host>`: Gateway WebSocket host (default: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket port (default: `18789`)
- `--tls`: Gumamit ng TLS para sa koneksyon sa gateway
- `--tls-fingerprint <sha256>`: Inaasahang fingerprint ng TLS certificate (sha256)
- `--node-id <id>`: I-override ang node id (nililinis ang pairing token)
- `--display-name <name>`: I-override ang display name ng node

## Serbisyo (background)

Mag-install ng headless na host ng node bilang isang user service.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Mga opsyon:

- `--host <host>`: Gateway WebSocket host (default: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket port (default: `18789`)
- `--tls`: Gumamit ng TLS para sa koneksyon sa gateway
- `--tls-fingerprint <sha256>`: Inaasahang fingerprint ng TLS certificate (sha256)
- `--node-id <id>`: I-override ang node id (nililinis ang pairing token)
- `--display-name <name>`: I-override ang display name ng node
- `--runtime <runtime>`: Runtime ng serbisyo (`node` o `bun`)
- `--force`: I-reinstall/i-overwrite kung naka-install na

Pamahalaan ang serbisyo:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Gamitin ang `openclaw node run` para sa isang foreground na host ng node (walang serbisyo).

Tumatanggap ang mga service command ng `--json` para sa machine-readable na output.

## Pag-pair

Ang unang koneksyon ay lumilikha ng pending node pair request sa Gateway.
Aprubahan ito sa pamamagitan ng:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Ini-store ng host ng node ang node id, token, display name, at impormasyon ng koneksyon sa gateway sa
`~/.openclaw/node.json`.

## Exec approvals

Ang `system.run` ay naka-gate ng mga lokal na exec approvals:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (i-edit mula sa Gateway)
