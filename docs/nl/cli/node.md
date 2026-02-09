---
summary: "CLI-referentie voor `openclaw node` (headless Node-host)"
read_when:
  - Het draaien van de headless Node-host
  - Het koppelen van een niet-macOS-node voor system.run
title: "node"
---

# `openclaw node`

Draai een **headless Node-host** die verbinding maakt met de Gateway WebSocket en
`system.run` / `system.which` op deze machine blootstelt.

## Waarom een Node-host gebruiken?

Gebruik een Node-host wanneer je wilt dat agents **opdrachten uitvoeren op andere machines** in je
netwerk zonder daar een volledige macOS Companion-app te installeren.

Veelvoorkomende use-cases:

- Opdrachten uitvoeren op externe Linux/Windows-systemen (buildservers, labmachines, NAS).
- Exec **gesandboxed** houden op de Gateway, maar goedgekeurde runs delegeren naar andere hosts.
- Een lichtgewicht, headless uitvoeringsdoel bieden voor automatisering of CI-nodes.

Uitvoering blijft beveiligd door **uitvoeringsgoedkeuringen** en per‑agent toegestane lijsten op de
Node-host, zodat je commandotoegang beperkt en expliciet houdt.

## Browserproxy (zero-config)

Node-hosts adverteren automatisch een browserproxy als `browser.enabled` niet is
uitgeschakeld op de Node. Hiermee kan de agent browserautomatisering op die Node gebruiken
zonder extra configuratie.

Schakel dit indien nodig uit op de Node:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Uitvoeren (foreground)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Opties:

- `--host <host>`: Gateway WebSocket-host (standaard: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket-poort (standaard: `18789`)
- `--tls`: TLS gebruiken voor de Gateway-verbinding
- `--tls-fingerprint <sha256>`: Verwachte TLS-certificaatvingerafdruk (sha256)
- `--node-id <id>`: Node-id overschrijven (wist pairing-token)
- `--display-name <name>`: Weergavenaam van de Node overschrijven

## Service (background)

Installeer een headless Node-host als gebruikersservice.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Opties:

- `--host <host>`: Gateway WebSocket-host (standaard: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket-poort (standaard: `18789`)
- `--tls`: TLS gebruiken voor de Gateway-verbinding
- `--tls-fingerprint <sha256>`: Verwachte TLS-certificaatvingerafdruk (sha256)
- `--node-id <id>`: Node-id overschrijven (wist pairing-token)
- `--display-name <name>`: Weergavenaam van de Node overschrijven
- `--runtime <runtime>`: Service-runtime (`node` of `bun`)
- `--force`: Opnieuw installeren/overschrijven indien al geïnstalleerd

Beheer de service:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Gebruik `openclaw node run` voor een foreground Node-host (geen service).

Service-opdrachten accepteren `--json` voor machineleesbare uitvoer.

## Pairing

De eerste verbinding maakt een openstaande Node-koppelingsaanvraag aan op de Gateway.
Keur deze goed via:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

De Node-host slaat zijn Node-id, token, weergavenaam en Gateway-verbindingsinformatie op in
`~/.openclaw/node.json`.

## Uitvoeringsgoedkeuringen

`system.run` is afgeschermd door lokale uitvoeringsgoedkeuringen:

- `~/.openclaw/exec-approvals.json`
- [Uitvoeringsgoedkeuringen](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (bewerken vanuit de Gateway)
