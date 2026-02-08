---
summary: "Webbläsarbaserat kontrollgränssnitt för Gateway (chatt, noder, konfig)"
read_when:
  - Du vill styra Gateway från en webbläsare
  - Du vill ha Tailnet-åtkomst utan SSH-tunnlar
title: "Kontroll-UI"
x-i18n:
  source_path: web/control-ui.md
  source_hash: baaaf73820f0e703
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:59Z
---

# Kontroll-UI (webbläsare)

Kontroll-UI:t är en liten **Vite + Lit**-single-page-app som serveras av Gateway:

- standard: `http://<host>:18789/`
- valfritt prefix: ställ in `gateway.controlUi.basePath` (t.ex. `/openclaw`)

Den talar **direkt med Gateway WebSocket** på samma port.

## Snabb öppning (lokalt)

Om Gateway körs på samma dator, öppna:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (eller [http://localhost:18789/](http://localhost:18789/))

Om sidan inte laddas, starta Gateway först: `openclaw gateway`.

Autentisering tillhandahålls under WebSocket-handshake via:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Inställningspanelen i instrumentpanelen låter dig spara en token; lösenord sparas inte.
  Introduktionsguiden genererar som standard en gateway-token, så klistra in den här vid första anslutningen.

## Enhetsparning (första anslutning)

När du ansluter till Kontroll-UI:t från en ny webbläsare eller enhet kräver Gateway
ett **engångsgodkännande för parning** — även om du är på samma Tailnet
med `gateway.auth.allowTailscale: true`. Detta är en säkerhetsåtgärd för att förhindra
obehörig åtkomst.

**Vad du ser:** "disconnected (1008): pairing required"

**För att godkänna enheten:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

När den har godkänts kommer enheten ihåg och kräver inte ny godkännandeprocess om du inte
återkallar den med `openclaw devices revoke --device <id> --role <role>`. Se
[Devices CLI](/cli/devices) för tokenrotation och återkallande.

**Noteringar:**

- Lokala anslutningar (`127.0.0.1`) godkänns automatiskt.
- Fjärranslutningar (LAN, Tailnet, etc.) kräver uttryckligt godkännande.
- Varje webbläsarprofil genererar ett unikt enhets-ID, så byte av webbläsare eller
  rensning av webbläsardata kräver ny parning.

## Vad det kan göra (idag)

- Chatta med modellen via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Strömma verktygsanrop + livekort för verktygsutdata i chatt (agenthändelser)
- Kanaler: status för WhatsApp/Telegram/Discord/Slack + plugin-kanaler (Mattermost, etc.), QR-inloggning + per-kanal-konfig (`channels.status`, `web.login.*`, `config.patch`)
- Instanser: närvarolista + uppdatera (`system-presence`)
- Sessioner: lista + per-session-åsidosättningar för thinking/verbose (`sessions.list`, `sessions.patch`)
- Cron-jobb: lista/lägg till/kör/aktivera/inaktivera + körhistorik (`cron.*`)
- Skills: status, aktivera/inaktivera, installera, uppdateringar av API-nycklar (`skills.*`)
- Noder: lista + caps (`node.list`)
- Exec-godkännanden: redigera gateway- eller nod-tillåtelselistor + fråga policy för `exec host=gateway/node` (`exec.approvals.*`)
- Konfig: visa/redigera `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Konfig: tillämpa + starta om med validering (`config.apply`) och väck den senast aktiva sessionen
- Konfigskrivningar inkluderar ett base-hash-skydd för att förhindra att samtidiga ändringar skrivs över
- Konfigschema + formulärrendering (`config.schema`, inklusive plugin- och kanalscheman); rå JSON-redigerare finns fortsatt tillgänglig
- Debug: status/hälsa/modell-ögonblicksbilder + händelselogg + manuella RPC-anrop (`status`, `health`, `models.list`)
- Loggar: live-tail av gateway-filloggar med filter/export (`logs.tail`)
- Uppdatera: kör paket-/git-uppdatering + omstart (`update.run`) med en omstartsrapport

Noteringar för panelen Cron-jobb:

- För isolerade jobb är leverans som standard inställd på att annonsera sammanfattning. Du kan växla till ingen om du vill ha interna körningar.
- Fälten kanal/mål visas när annonsera är valt.

## Chattbeteende

- `chat.send` är **icke-blockerande**: den kvitterar omedelbart med `{ runId, status: "started" }` och svaret strömmas via `chat`-händelser.
- Återsändning med samma `idempotencyKey` returnerar `{ status: "in_flight" }` medan den körs, och `{ status: "ok" }` efter slutförande.
- `chat.inject` lägger till en assistentnotering i sessionsutskriften och sänder en `chat`-händelse för UI-endast-uppdateringar (ingen agentkörning, ingen kanalleverans).
- Stoppa:
  - Klicka **Stop** (anropar `chat.abort`)
  - Skriv `/stop` (eller `stop|esc|abort|wait|exit|interrupt`) för att avbryta utanför bandet
  - `chat.abort` stöder `{ sessionKey }` (ingen `runId`) för att avbryta alla aktiva körningar för den sessionen

## Tailnet-åtkomst (rekommenderas)

### Integrerad Tailscale Serve (föredras)

Behåll Gateway på loopback och låt Tailscale Serve proxy den med HTTPS:

```bash
openclaw gateway --tailscale serve
```

Öppna:

- `https://<magicdns>/` (eller din konfigurerade `gateway.controlUi.basePath`)

Som standard kan Serve-förfrågningar autentisera via Tailscale-identitetshuvuden
(`tailscale-user-login`) när `gateway.auth.allowTailscale` är `true`. OpenClaw
verifierar identiteten genom att slå upp `x-forwarded-for`-adressen med
`tailscale whois` och matcha den mot huvudet, och accepterar endast dessa när
förfrågan träffar loopback med Tailscales `x-forwarded-*`-huvuden. Ställ in
`gateway.auth.allowTailscale: false` (eller tvinga `gateway.auth.mode: "password"`)
om du vill kräva token/lösenord även för Serve-trafik.

### Binda till tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Öppna sedan:

- `http://<tailscale-ip>:18789/` (eller din konfigurerade `gateway.controlUi.basePath`)

Klistra in token i UI-inställningarna (skickas som `connect.params.auth.token`).

## Osäker HTTP

Om du öppnar instrumentpanelen över vanlig HTTP (`http://<lan-ip>` eller `http://<tailscale-ip>`),
kör webbläsaren i ett **icke-säkert sammanhang** och blockerar WebCrypto. Som standard
**blockerar** OpenClaw Kontroll-UI-anslutningar utan enhetsidentitet.

**Rekommenderad åtgärd:** använd HTTPS (Tailscale Serve) eller öppna UI:t lokalt:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (på gateway-värden)

**Nedgraderings­exempel (endast token över HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

Detta inaktiverar enhetsidentitet + parning för Kontroll-UI:t (även över HTTPS). Använd
endast om du litar på nätverket.

Se [Tailscale](/gateway/tailscale) för vägledning om HTTPS-konfiguration.

## Bygga UI:t

Gateway serverar statiska filer från `dist/control-ui`. Bygg dem med:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Valfri absolut bas (när du vill ha fasta tillgångs-URL:er):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

För lokal utveckling (separat dev-server):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Peka sedan UI:t mot din Gateway WS-URL (t.ex. `ws://127.0.0.1:18789`).

## Felsökning/test: dev-server + fjärr-Gateway

Kontroll-UI:t är statiska filer; WebSocket-målet är konfigurerbart och kan vara
annat än HTTP-ursprunget. Detta är praktiskt när du vill köra Vite-dev-servern
lokalt men Gateway körs någon annanstans.

1. Starta UI-dev-servern: `pnpm ui:dev`
2. Öppna en URL som:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Valfri engångsautentisering (om det behövs):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Noteringar:

- `gatewayUrl` lagras i localStorage efter laddning och tas bort från URL:en.
- `token` lagras i localStorage; `password` hålls endast i minnet.
- När `gatewayUrl` är satt faller UI:t inte tillbaka till konfig- eller miljöuppgifter.
  Tillhandahåll `token` (eller `password`) uttryckligen. Saknade uttryckliga uppgifter är ett fel.
- Använd `wss://` när Gateway är bakom TLS (Tailscale Serve, HTTPS-proxy, etc.).
- `gatewayUrl` accepteras endast i ett toppnivåfönster (inte inbäddat) för att förhindra clickjacking.
- För cross-origin-dev-upplägg (t.ex. `pnpm ui:dev` till en fjärr-Gateway), lägg till UI:ts
  ursprung i `gateway.controlUi.allowedOrigins`.

Exempel:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Detaljer för fjärråtkomst: [Remote access](/gateway/remote).
