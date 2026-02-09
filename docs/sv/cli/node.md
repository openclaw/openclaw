---
summary: "CLI-referens för `openclaw node` (huvudlös node‑värd)"
read_when:
  - Köra den huvudlösa node‑värden
  - Para ihop en node som inte är macOS för system.run
title: "node"
---

# `openclaw node`

Kör en **huvudlös node‑värd** som ansluter till Gateway WebSocket och exponerar
`system.run` / `system.which` på den här maskinen.

## Varför använda en node‑värd?

Använd en node‑värd när du vill att agenter ska **köra kommandon på andra maskiner** i ditt
nätverk utan att installera en fullständig macOS‑companion‑app där.

Vanliga användningsfall:

- Kör kommandon på fjärranslutna Linux/Windows‑maskiner (byggservrar, labbmaskiner, NAS).
- Behåll exec **sandboxed** på gatewayen, men delegera godkända körningar till andra värdar.
- Tillhandahåll ett lättviktigt, huvudlöst exekveringsmål för automation eller CI‑noder.

Exekvering skyddas fortfarande av **exec‑godkännanden** och per‑agent‑tillåtelselistor på
node‑värden, så att du kan hålla kommandoåtkomst avgränsad och explicit.

## Webbläsarproxy (nollkonfig)

Node värdar annonserar automatiskt en webbläsarproxy om `browser.enabled` inte är
inaktiverat på noden. Detta låter agenten använda webbläsarautomatisering på den noden
utan extra konfiguration.

Inaktivera den på noden vid behov:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Kör (förgrund)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Alternativ:

- `--host <host>`: Gateway WebSocket‑värd (standard: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket‑port (standard: `18789`)
- `--tls`: Använd TLS för gateway‑anslutningen
- `--tls-fingerprint <sha256>`: Förväntat TLS‑certifikatets fingeravtryck (sha256)
- `--node-id <id>`: Åsidosätt node‑id (rensar parningstoken)
- `--display-name <name>`: Åsidosätt nodens visningsnamn

## Tjänst (bakgrund)

Installera en huvudlös node‑värd som en användartjänst.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Alternativ:

- `--host <host>`: Gateway WebSocket‑värd (standard: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket‑port (standard: `18789`)
- `--tls`: Använd TLS för gateway‑anslutningen
- `--tls-fingerprint <sha256>`: Förväntat TLS‑certifikatets fingeravtryck (sha256)
- `--node-id <id>`: Åsidosätt node‑id (rensar parningstoken)
- `--display-name <name>`: Åsidosätt nodens visningsnamn
- `--runtime <runtime>`: Tjänstens körtid (`node` eller `bun`)
- `--force`: Installera om/skriv över om den redan är installerad

Hantera tjänsten:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Använd `openclaw node run` för en node‑värd i förgrund (ingen tjänst).

Tjänstkommandon accepterar `--json` för maskinläsbar utdata.

## Parning

Den första anslutningen skapar en väntande nod parförfrågan på Gateway.
Godkänn det via:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Node‑värden lagrar sitt node‑id, token, visningsnamn och gateway‑anslutningsinformation i
`~/.openclaw/node.json`.

## Exec‑godkännanden

`system.run` är skyddat av lokala exec‑godkännanden:

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (redigera från Gateway)
