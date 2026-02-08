---
summary: "Browserbaseret kontrol-UI til Gateway (chat, noder, konfiguration)"
read_when:
  - Du vil betjene Gateway fra en browser
  - Du vil have Tailnet-adgang uden SSH-tunneler
title: "Kontrol-UI"
x-i18n:
  source_path: web/control-ui.md
  source_hash: baaaf73820f0e703
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:58Z
---

# Kontrol-UI (browser)

Kontrol-UI’et er en lille **Vite + Lit** single-page app, som serveres af Gateway:

- standard: `http://<host>:18789/`
- valgfrit præfiks: sæt `gateway.controlUi.basePath` (f.eks. `/openclaw`)

Det taler **direkte med Gateway WebSocket** på samme port.

## Hurtig åbning (lokalt)

Hvis Gateway kører på den samme computer, så åbn:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (eller [http://localhost:18789/](http://localhost:18789/))

Hvis siden ikke indlæses, så start Gateway først: `openclaw gateway`.

Autentificering leveres under WebSocket-handshaket via:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Dashboardets indstillingspanel lader dig gemme et token; adgangskoder gemmes ikke.
  Introduktionsguiden genererer som standard et gateway-token, så indsæt det her ved første forbindelse.

## Enhedsparring (første forbindelse)

Når du forbinder til Kontrol-UI’et fra en ny browser eller enhed, kræver Gateway
en **engangs-godkendelse af parring** — selv hvis du er på det samme Tailnet
med `gateway.auth.allowTailscale: true`. Dette er en sikkerhedsforanstaltning for at forhindre
uautoriseret adgang.

**Det, du vil se:** "disconnected (1008): pairing required"

**Sådan godkender du enheden:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Når den er godkendt, bliver enheden husket og kræver ikke gen-godkendelse, medmindre
du tilbagekalder den med `openclaw devices revoke --device <id> --role <role>`. Se
[Devices CLI](/cli/devices) for token-rotation og tilbagekaldelse.

**Noter:**

- Lokale forbindelser (`127.0.0.1`) godkendes automatisk.
- Fjernforbindelser (LAN, Tailnet osv.) kræver eksplicit godkendelse.
- Hver browserprofil genererer et unikt enheds-id, så skift af browser eller
  rydning af browserdata kræver ny parring.

## Hvad det kan (i dag)

- Chat med modellen via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Streame værktøjskald + live kort med værktøjsoutput i Chat (agent-events)
- Kanaler: WhatsApp/Telegram/Discord/Slack + plugin-kanaler (Mattermost m.fl.) status + QR-login + konfiguration pr. kanal (`channels.status`, `web.login.*`, `config.patch`)
- Instanser: tilstedeværelsesliste + opdatering (`system-presence`)
- Sessioner: liste + tilsidesættelser pr. session for thinking/verbose (`sessions.list`, `sessions.patch`)
- Cron jobs: list/tilføj/kør/aktivér/deaktivér + kørsels-historik (`cron.*`)
- Skills: status, aktivér/deaktivér, installér, opdatering af API-nøgler (`skills.*`)
- Noder: liste + kapaciteter (`node.list`)
- Exec-godkendelser: redigér gateway- eller node-tilladelseslister + forespørg politik for `exec host=gateway/node` (`exec.approvals.*`)
- Konfiguration: vis/redigér `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Konfiguration: anvend + genstart med validering (`config.apply`) og væk den sidst aktive session
- Konfigurationsskrivninger inkluderer en base-hash-beskyttelse for at forhindre overskrivning af samtidige ændringer
- Konfigurationsskema + formular-rendering (`config.schema`, inklusive plugin- og kanalskemaer); rå JSON-editor er fortsat tilgængelig
- Debug: status/helbred/model-øjebliksbilleder + hændelseslog + manuelle RPC-kald (`status`, `health`, `models.list`)
- Logs: live tail af gateway-fil-logs med filtrering/eksport (`logs.tail`)
- Opdatering: kør en pakke/git-opdatering + genstart (`update.run`) med en genstartsrapport

Noter til Cron jobs-panelet:

- For isolerede jobs er levering som standard sat til at annoncere et resumé. Du kan skifte til none, hvis du ønsker interne kørsler uden annoncering.
- Felter for kanal/mål vises, når announce er valgt.

## Chat-adfærd

- `chat.send` er **ikke-blokerende**: den kvitterer straks med `{ runId, status: "started" }`, og svaret streames via `chat`-events.
- Genafsendelse med samme `idempotencyKey` returnerer `{ status: "in_flight" }`, mens den kører, og `{ status: "ok" }` efter fuldførelse.
- `chat.inject` tilføjer en assistent-note til sessionens transskription og udsender et `chat`-event til UI-opdateringer (ingen agent-kørsel, ingen kanal-levering).
- Stop:
  - Klik **Stop** (kalder `chat.abort`)
  - Skriv `/stop` (eller `stop|esc|abort|wait|exit|interrupt`) for at afbryde out-of-band
  - `chat.abort` understøtter `{ sessionKey }` (ingen `runId`) for at afbryde alle aktive kørsler for den session

## Tailnet-adgang (anbefalet)

### Integreret Tailscale Serve (foretrukken)

Behold Gateway på loopback og lad Tailscale Serve proxy’e den med HTTPS:

```bash
openclaw gateway --tailscale serve
```

Åbn:

- `https://<magicdns>/` (eller din konfigurerede `gateway.controlUi.basePath`)

Som standard kan Serve-forespørgsler autentificere via Tailscale-identitetshoveder
(`tailscale-user-login`), når `gateway.auth.allowTailscale` er `true`. OpenClaw
verificerer identiteten ved at slå `x-forwarded-for`-adressen op med
`tailscale whois` og matche den med headeren, og accepterer kun disse, når
forespørgslen rammer loopback med Tailscales `x-forwarded-*`-headers. Sæt
`gateway.auth.allowTailscale: false` (eller gennemtving `gateway.auth.mode: "password"`),
hvis du vil kræve token/adgangskode selv for Serve-trafik.

### Bind til tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Åbn derefter:

- `http://<tailscale-ip>:18789/` (eller din konfigurerede `gateway.controlUi.basePath`)

Indsæt token’et i UI-indstillingerne (sendes som `connect.params.auth.token`).

## Usikker HTTP

Hvis du åbner dashboardet over almindelig HTTP (`http://<lan-ip>` eller `http://<tailscale-ip>`),
kører browseren i en **ikke-sikker kontekst** og blokerer WebCrypto. Som standard
**blokerer** OpenClaw forbindelser til Kontrol-UI uden enhedsidentitet.

**Anbefalet løsning:** brug HTTPS (Tailscale Serve) eller åbn UI’et lokalt:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (på gateway-værten)

**Nedgraderings-eksempel (kun token over HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

Dette deaktiverer enhedsidentitet + parring for Kontrol-UI’et (selv over HTTPS). Brug
kun dette, hvis du stoler på netværket.

Se [Tailscale](/gateway/tailscale) for vejledning i HTTPS-opsætning.

## Bygning af UI’et

Gateway serverer statiske filer fra `dist/control-ui`. Byg dem med:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Valgfri absolut base (når du vil have faste asset-URL’er):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Til lokal udvikling (separat dev-server):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Peg derefter UI’et mod din Gateway WS-URL (f.eks. `ws://127.0.0.1:18789`).

## Debugging/test: dev-server + fjern-Gateway

Kontrol-UI’et er statiske filer; WebSocket-målet er konfigurerbart og kan være
forskelligt fra HTTP-origin. Dette er praktisk, når du vil køre Vite dev-serveren
lokalt, men Gateway kører et andet sted.

1. Start UI dev-serveren: `pnpm ui:dev`
2. Åbn en URL som:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Valgfri engangsautentificering (hvis nødvendigt):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Noter:

- `gatewayUrl` gemmes i localStorage efter indlæsning og fjernes fra URL’en.
- `token` gemmes i localStorage; `password` holdes kun i hukommelsen.
- Når `gatewayUrl` er sat, falder UI’et ikke tilbage til konfigurations- eller miljølegitimationsoplysninger.
  Angiv `token` (eller `password`) eksplicit. Manglende eksplicitte legitimationsoplysninger er en fejl.
- Brug `wss://`, når Gateway er bag TLS (Tailscale Serve, HTTPS-proxy osv.).
- `gatewayUrl` accepteres kun i et topniveau-vindue (ikke indlejret) for at forhindre clickjacking.
- For cross-origin dev-opsætninger (f.eks. `pnpm ui:dev` til en fjern-Gateway), tilføj UI’ets
  origin til `gateway.controlUi.allowedOrigins`.

Eksempel:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Detaljer om fjernadgangsopsætning: [Remote access](/gateway/remote).
