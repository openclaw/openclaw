---
summary: "Browsergebaseerde bedienings-UI voor de Gateway (chat, nodes, config)"
read_when:
  - Je wilt de Gateway vanuit een browser bedienen
  - Je wilt Tailnet-toegang zonder SSH-tunnels
title: "Control UI"
---

# Control UI (browser)

De Control UI is een kleine **Vite + Lit** single-page app die door de Gateway wordt geserveerd:

- standaard: `http://<host>:18789/`
- optionele prefix: stel `gateway.controlUi.basePath` in (bijv. `/openclaw`)

Hij communiceert **rechtstreeks met de Gateway WebSocket** op dezelfde poort.

## Snel openen (lokaal)

Als de Gateway op dezelfde computer draait, open:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (of [http://localhost:18789/](http://localhost:18789/))

Als de pagina niet laadt, start eerst de Gateway: `openclaw gateway`.

Authenticatie wordt tijdens de WebSocket-handshake aangeleverd via:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Het instellingenpaneel van het dashboard laat je een token opslaan; wachtwoorden worden niet opgeslagen.
  De onboarding-wizard genereert standaard een gateway-token, dus plak dit hier bij de eerste verbinding.

## Apparaatkoppeling (eerste verbinding)

Wanneer je de Control UI vanaf een nieuwe browser of apparaat opent, vereist de Gateway
een **eenmalige koppelingsgoedkeuring** — zelfs als je je op hetzelfde Tailnet bevindt
met `gateway.auth.allowTailscale: true`. Dit is een beveiligingsmaatregel om
ongeautoriseerde toegang te voorkomen.

**Wat je ziet:** "disconnected (1008): pairing required"

**Om het apparaat goed te keuren:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Na goedkeuring wordt het apparaat onthouden en is hernieuwde goedkeuring niet nodig,
tenzij je deze intrekt met `openclaw devices revoke --device <id> --role <role>`. Zie
[Devices CLI](/cli/devices) voor tokenrotatie en intrekking.

**Notities:**

- Lokale verbindingen (`127.0.0.1`) worden automatisch goedgekeurd.
- Externe verbindingen (LAN, Tailnet, enz.) vereisen expliciete goedkeuring.
- Elk browserprofiel genereert een unieke apparaat-ID; wisselen van browser of
  het wissen van browsergegevens vereist opnieuw koppelen.

## Wat het kan (nu)

- Chatten met het model via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Tool-calls streamen + live tool-uitvoerkaarten in Chat (agent-events)
- Kanalen: WhatsApp/Telegram/Discord/Slack + plugin-kanalen (Mattermost, enz.) status + QR-login + per-kanaalconfiguratie (`channels.status`, `web.login.*`, `config.patch`)
- Instanties: aanwezigheidslijst + verversen (`system-presence`)
- Sessies: lijst + per-sessie overrides voor thinking/verbose (`sessions.list`, `sessions.patch`)
- Cron-jobs: lijst/toevoegen/uitvoeren/inschakelen/uitschakelen + uitvoergeschiedenis (`cron.*`)
- Skills: status, in-/uitschakelen, installeren, API-sleutelupdates (`skills.*`)
- Nodes: lijst + caps (`node.list`)
- Uitvoeringsgoedkeuringen: gateway- of node-toegestane lijsten bewerken + beleid vragen voor `exec host=gateway/node` (`exec.approvals.*`)
- Config: bekijken/bewerken `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Config: toepassen + herstarten met validatie (`config.apply`) en de laatst actieve sessie wekken
- Config-wegschrijvingen bevatten een base-hash-beveiliging om het overschrijven van gelijktijdige bewerkingen te voorkomen
- Config-schema + formulierweergave (`config.schema`, inclusief plugin- en kanaalschema’s); de Raw JSON-editor blijft beschikbaar
- Debug: status/health/model-snapshots + eventlog + handmatige RPC-calls (`status`, `health`, `models.list`)
- Logs: live tail van gateway-bestandslogs met filter/export (`logs.tail`)
- Update: een package/git-update uitvoeren + herstarten (`update.run`) met een herstartrapport

Notities bij het Cron-jobs-paneel:

- Voor geïsoleerde jobs staat de levering standaard op aankondiging van een samenvatting. Je kunt dit op geen zetten als je alleen interne runs wilt.
- Velden voor kanaal/doel verschijnen wanneer aankondigen is geselecteerd.

## Chatgedrag

- `chat.send` is **niet-blokkerend**: het bevestigt onmiddellijk met `{ runId, status: "started" }` en de respons streamt via `chat`-events.
- Opnieuw verzenden met dezelfde `idempotencyKey` geeft `{ status: "in_flight" }` terug tijdens het uitvoeren, en `{ status: "ok" }` na voltooiing.
- `chat.inject` voegt een assistentnotitie toe aan het sessietranscript en zendt een `chat`-event uit voor UI-only updates (geen agent-run, geen kanaallevering).
- Stoppen:
  - Klik **Stop** (roept `chat.abort` aan)
  - Typ `/stop` (of `stop|esc|abort|wait|exit|interrupt`) om out-of-band te annuleren
  - `chat.abort` ondersteunt `{ sessionKey }` (geen `runId`) om alle actieve runs voor die sessie te stoppen

## Tailnet-toegang (aanbevolen)

### Geïntegreerde Tailscale Serve (voorkeur)

Houd de Gateway op loopback en laat Tailscale Serve deze met HTTPS proxyen:

```bash
openclaw gateway --tailscale serve
```

Open:

- `https://<magicdns>/` (of je geconfigureerde `gateway.controlUi.basePath`)

Standaard kunnen Serve-verzoeken authenticeren via Tailscale-identiteitsheaders
(`tailscale-user-login`) wanneer `gateway.auth.allowTailscale` is `true`. OpenClaw
verifieert de identiteit door het `x-forwarded-for`-adres te resolven met
`tailscale whois` en dit te matchen met de header, en accepteert deze alleen wanneer het
verzoek loopback raakt met Tailscale’s `x-forwarded-*`-headers. Stel
`gateway.auth.allowTailscale: false` in (of forceer `gateway.auth.mode: "password"`)
als je ook voor Serve-verkeer een token/wachtwoord wilt vereisen.

### Binden aan tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Open daarna:

- `http://<tailscale-ip>:18789/` (of je geconfigureerde `gateway.controlUi.basePath`)

Plak het token in de UI-instellingen (verzonden als `connect.params.auth.token`).

## Onbeveiligd HTTP

Als je het dashboard opent via plain HTTP (`http://<lan-ip>` of `http://<tailscale-ip>`),
draait de browser in een **niet-beveiligde context** en blokkeert WebCrypto. Standaard
**blokkeert** OpenClaw Control UI-verbindingen zonder apparaatidentiteit.

**Aanbevolen oplossing:** gebruik HTTPS (Tailscale Serve) of open de UI lokaal:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (op de Gateway-host)

**Downgrade-voorbeeld (alleen token over HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

Dit schakelt apparaatidentiteit + koppeling uit voor de Control UI (zelfs op HTTPS). Gebruik
dit alleen als je het netwerk vertrouwt.

Zie [Tailscale](/gateway/tailscale) voor richtlijnen voor HTTPS-instelling.

## De UI bouwen

De Gateway serveert statische bestanden vanuit `dist/control-ui`. Bouw ze met:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Optionele absolute base (wanneer je vaste asset-URL’s wilt):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Voor lokale ontwikkeling (aparte dev-server):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Richt daarna de UI op je Gateway WS-URL (bijv. `ws://127.0.0.1:18789`).

## Debuggen/testen: dev-server + externe Gateway

De Control UI bestaat uit statische bestanden; het WebSocket-doel is configureerbaar en kan
afwijken van de HTTP-origin. Dit is handig wanneer je de Vite dev-server lokaal wilt draaien
maar de Gateway elders draait.

1. Start de UI dev-server: `pnpm ui:dev`
2. Open een URL zoals:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Optionele eenmalige authenticatie (indien nodig):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Notities:

- `gatewayUrl` wordt na het laden opgeslagen in localStorage en uit de URL verwijderd.
- `token` wordt opgeslagen in localStorage; `password` blijft alleen in het geheugen.
- Wanneer `gatewayUrl` is ingesteld, valt de UI niet terug op config- of omgevingsreferenties.
  Lever `token` (of `password`) expliciet aan. Het ontbreken van expliciete referenties is een fout.
- Gebruik `wss://` wanneer de Gateway achter TLS staat (Tailscale Serve, HTTPS-proxy, enz.).
- `gatewayUrl` wordt alleen geaccepteerd in een top-level venster (niet ingebed) om clickjacking te voorkomen.
- Voor cross-origin dev-opstellingen (bijv. `pnpm ui:dev` naar een externe Gateway), voeg de UI-
  origin toe aan `gateway.controlUi.allowedOrigins`.

Voorbeeld:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Details voor externe toegang: [Remote access](/gateway/remote).
