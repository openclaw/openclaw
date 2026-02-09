---
summary: "CLI-reference for `openclaw node` (headless node-vært)"
read_when:
  - Når du kører den headless node-vært
  - Paring af en ikke-macOS-node til system.run
title: "node"
---

# `openclaw node`

Kør en **headless node-vært**, der forbinder til Gateway WebSocket og eksponerer
`system.run` / `system.which` på denne maskine.

## Hvorfor bruge en node-vært?

Brug en node-vært, når du vil have agenter til at **køre kommandoer på andre maskiner** i dit
netværk uden at installere en fuld macOS companion-app der.

Almindelige brugsscenarier:

- Kør kommandoer på fjerntliggende Linux/Windows-maskiner (build-servere, labmaskiner, NAS).
- Hold exec **sandboxed** på gatewayen, men uddeleger godkendte kørsler til andre værter.
- Stil et letvægts, headless eksekveringsmål til rådighed for automatisering eller CI-noder.

Eksekvering er stadig beskyttet af **exec-godkendelser** og pr.-agent tilladelseslister på
node-værten, så du kan holde kommandoadgang afgrænset og eksplicit.

## Browser-proxy (nul-konfiguration)

Node værter automatisk annoncere en browser proxy hvis `browser.enabled` er ikke
deaktiveret på noden. Dette lader agenten bruge browser automation på den node
uden ekstra konfiguration.

Deaktivér den på noden, hvis nødvendigt:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Kør (forgrund)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Indstillinger:

- `--host <host>`: Gateway WebSocket-vært (standard: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket-port (standard: `18789`)
- `--tls`: Brug TLS til gateway-forbindelsen
- `--tls-fingerprint <sha256>`: Forventet TLS-certifikatfingeraftryk (sha256)
- `--node-id <id>`: Tilsidesæt node-id (rydder pairing-token)
- `--display-name <name>`: Tilsidesæt nodens visningsnavn

## Tjeneste (baggrund)

Installér en headless node-vært som en brugertjeneste.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Indstillinger:

- `--host <host>`: Gateway WebSocket-vært (standard: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket-port (standard: `18789`)
- `--tls`: Brug TLS til gateway-forbindelsen
- `--tls-fingerprint <sha256>`: Forventet TLS-certifikatfingeraftryk (sha256)
- `--node-id <id>`: Tilsidesæt node-id (rydder pairing-token)
- `--display-name <name>`: Tilsidesæt nodens visningsnavn
- `--runtime <runtime>`: Tjenestens runtime (`node` eller `bun`)
- `--force`: Geninstallér/overskriv, hvis den allerede er installeret

Administrér tjenesten:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Brug `openclaw node run` til en node-vært i forgrunden (ingen tjeneste).

Tjenestekommandoer accepterer `--json` for maskinlæsbar output.

## Paring

Den første forbindelse opretter en afventende node par anmodning på Gateway.
Godkend det via:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Node-værten gemmer sit node-id, token, visningsnavn og gateway-forbindelsesinfo i
`~/.openclaw/node.json`.

## Exec-godkendelser

`system.run` er afgrænset af lokale exec-godkendelser:

- `~/.openclaw/exec-approvals.json`
- [Exec-godkendelser](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (redigér fra Gatewayen)
