---
summary: "Browserbaseret kontrol-UI til Gateway (chat, noder, konfiguration)"
read_when:
  - Du vil betjene Gateway fra en browser
  - Du vil have Tailnet-adgang uden SSH-tunneler
title: "Kontrol-UI"
---

# Kontrol-UI (browser)

Kontrol-UI’et er en lille **Vite + Lit** single-page app, som serveres af Gateway:

- standard: `http://<host>:18789/`
- valgfri præfiks: sæt `gateway.controlUi.basePath` (f.eks. `/openclaw`)

Det taler **direkte med Gateway WebSocket** på samme port.

## Hurtig åbning (lokalt)

Hvis Gateway kører på den samme computer, så åbn:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (eller [http://localhost:18789/](http://localhost:18789/))

Hvis siden ikke indlæses, så start Gateway først: `openclaw gateway`.

Autentificering leveres under WebSocket-handshaket via:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Kontrolpanelet giver dig mulighed for at gemme et token; adgangskoder er ikke vedvarende.
  Onboarding-guiden genererer som standard en gateway-token, så indsæt den her ved første forbindelse.

## Enhedsparring (første forbindelse)

Når du opretter forbindelse til Control UI fra en ny browser eller enhed, Gateway
kræver en **engangs parring godkendelse** — selv om du er på den samme Tailnet
med \`gateway. uth.allowTailscale: true«. Dette er en sikkerhedsforanstaltning for at forhindre
uautoriseret adgang.

**Det, du vil se:** "disconnected (1008): pairing required"

**Sådan godkender du enheden:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Når enheden er godkendt, huskes enheden og kræver ikke gengodkendelse, medmindre
du tilbagekalder den med `openclaw enheder tilbagekalder --device <id> --role <role>`. Se
[Enheder CLI](/cli/devices) for token rotation og tilbagekaldelse.

**Noter:**

- Lokale forbindelser (`127.0.0.1`) godkendes automatisk.
- Fjernforbindelser (LAN, Tailnet osv.) kræver udtrykkelig godkendelse.
- Hver browserprofil genererer et unikt enheds-id, så skift af browser eller
  rydning af browserdata kræver ny parring.

## Hvad det kan (i dag)

- Chat med modellen via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Streame værktøjskald + live kort med værktøjsoutput i Chat (agent-events)
- Kanaler: WhatsApp/Telegram/Discord/Slack + plugin-kanaler (Mattermost, etc.) status + QR login + per-kanal config (`channels.status`, `web.login.*`, `config.patch`)
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

- For isolerede job, leveres som standard til at annoncere resumé. Du kan skifte til ingen, hvis du vil have interne kørsler.
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

Som standard kan Serveres anmodninger autentificere via Tailscale identitetsidehoveder
(`tailscale-user-login`) når `gateway.auth.allowTailscale` er `true`. OpenClaw
verificerer identiteten ved at løse 'x-forwarded-for'-adressen med
'tailscale whois' og matche den til headeren, og accepterer kun disse, når
-anmodningen rammer loopback med Tailscales 'x-forwarded-\*'-headere. Angiv
`gateway.auth.allowTailscale: false` (eller force `gateway.auth.mode: "password"`)
, hvis du ønsker at kræve et token/password selv for Serv trafik.

### Bind til tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Åbn derefter:

- `http://<tailscale-ip>:18789/` (eller din konfigurerede `gateway.controlUi.basePath`)

Indsæt token’et i UI-indstillingerne (sendes som `connect.params.auth.token`).

## Usikker HTTP

Hvis du åbner instrumentbrættet over almindeligt HTTP (`http://<lan-ip>` eller `http://<tailscale-ip>`),
browseren kører i en **ikke-sikker kontekst** og blokerer WebCrypto. Som standard styrer
OpenClaw **blokke** UI-forbindelser uden enhedsidentitet.

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

Dette deaktiverer enhedsidentitet + parring til Control UI (selv på HTTPS). Brug kun
hvis du stoler på netværket.

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

Derefter pege på UI på din Gateway WS URL (fx `ws://127.0.0.1:18789`).

## Debugging/test: dev-server + fjern-Gateway

Den Control UI er statiske filer; WebSocket mål er konfigurerbar og kan være
forskellig fra HTTP oprindelse. Dette er praktisk, når du vil have Vite dev server
lokalt, men Gateway kører andre steder.

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
- Når `gatewayUrl` er indstillet, UI ikke falder tilbage til config eller miljø legitimationsoplysninger.
  Angiv eksplicit `token` (eller `password`). Manglende eksplicitte legitimationsoplysninger er en fejl.
- Brug `wss://`, når Gateway er bag TLS (Tailscale Serve, HTTPS-proxy osv.).
- `gatewayUrl` accepteres kun i et topniveau-vindue (ikke indlejret) for at forhindre clickjacking.
- For cross-origin dev opsætninger (fx `pnpm ui:dev` til en ekstern Gateway), tilføje UI
  oprindelse til `gateway.controlUi.allowedOrigins`.

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
