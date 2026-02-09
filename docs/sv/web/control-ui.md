---
summary: "Webbläsarbaserat kontrollgränssnitt för Gateway (chatt, noder, konfig)"
read_when:
  - Du vill styra Gateway från en webbläsare
  - Du vill ha Tailnet-åtkomst utan SSH-tunnlar
title: "Kontroll-UI"
---

# Kontroll-UI (webbläsare)

Kontroll-UI:t är en liten **Vite + Lit**-single-page-app som serveras av Gateway:

- standard: `http://<host>:18789/`
- valfritt prefix: sätt `gateway.controlUi.basePath` (t.ex. `/openclaw`)

Den talar **direkt med Gateway WebSocket** på samma port.

## Snabb öppning (lokalt)

Om Gateway körs på samma dator, öppna:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (eller [http://localhost:18789/](http://localhost:18789/))

Om sidan inte laddas, starta Gateway först: `openclaw gateway`.

Autentisering tillhandahålls under WebSocket-handshake via:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Instrumentpanelens inställningspanel låter dig lagra en token; lösenord är inte beständiga.
  Onboarding guiden genererar en gateway token som standard, så klistra in det här vid första anslutningen.

## Enhetsparning (första anslutning)

När du ansluter till styrgränssnittet från en ny webbläsare eller enhet, Gateway
kräver ett **en-gångs parningsgodkännande** — även om du är på samma Tailnet
med \`gateway. uth.allowSkala: sant. Detta är en säkerhetsåtgärd för att förhindra
obehörig åtkomst.

**Vad du ser:** "disconnected (1008): pairing required"

**För att godkänna enheten:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Once approved, the device is remembered and won't require re-approval unless
you revoke it with `openclaw devices revoke --device <id> --role <role>`. Se
[Enheter CLI](/cli/devices) för token rotation och återkallelse.

**Noteringar:**

- Lokala anslutningar (`127.0.0.1`) godkänns automatiskt.
- Fjärranslutningar (LAN, Tailnet etc.) kräver uttryckligt godkännande.
- Varje webbläsarprofil genererar ett unikt enhets-ID, så byte av webbläsare eller
  rensning av webbläsardata kräver ny parning.

## Vad det kan göra (idag)

- Chatta med modellen via Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Strömma verktygsanrop + livekort för verktygsutdata i chatt (agenthändelser)
- Kanaler: WhatsApp/Telegram/Discord/Slack + plugin-kanaler (Mattermost, etc.) status + QR-inloggning + konfiguration per kanal (`channels.status`, `web.login.*`, `config.patch`)
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

- För isolerade jobb är leveransstandard att meddela sammanfattning. Du kan byta till ingen om du vill ha interna körningar.
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

Som standard kan Serve förfrågningar autentisera via Tailscale identitetshuvuden
(`tailscale-user-login`) när `gateway.auth.allowTailscale` är `true`. OpenClaw
verifierar identiteten genom att lösa `x-forwarded-for`-adressen med
`tailscale whois` och matcha den med huvudet, och accepterar endast dessa när
-förfrågan träffar loopback med Tailscales `x-forwarded-*`-rubriker. Ställ in
`gateway.auth.allowTailscale: false` (eller tvinga `gateway.auth.mode: "password"`)
om du vill kräva en token/lösenord även för Serve trafik.

### Binda till tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Öppna sedan:

- `http://<tailscale-ip>:18789/` (eller din konfigurerade `gateway.controlUi.basePath`)

Klistra in token i UI-inställningarna (skickas som `connect.params.auth.token`).

## Osäker HTTP

Om du öppnar instrumentpanelen över vanlig HTTP (`http://<lan-ip>` eller `http://<tailscale-ip>`),
webbläsaren körs i en **osäker kontext** och blockerar WebCrypto. Som standard,
OpenClaw **block** Kontroll UI-anslutningar utan enhetsidentitet.

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

Detta inaktiverar enhetsidentitet + parkoppling för styrgränssnittet (även på HTTPS). Använd
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

Peka sedan UI på din Gateway WS URL (t.ex. `ws://127.0.0.1:18789`).

## Felsökning/test: dev-server + fjärr-Gateway

Control UI är statiska filer; WebSocket målet är konfigurerbar och kan vara
skiljer sig från HTTP ursprung. Detta är praktiskt när du vill att Vite dev-servern
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
- När `gatewayUrl` är satt, faller UI inte tillbaka till config eller miljö uppgifter.
  Ange `token` (eller `lösenord`) explicit. Saknar explicita referenser är ett fel.
- Använd `wss://` när Gateway är bakom TLS (Tailscale Serve, HTTPS-proxy, etc.).
- `gatewayUrl` accepteras endast i ett toppnivåfönster (inte inbäddat) för att förhindra clickjacking.
- För cross-origin dev-inställningar (t.ex. `pnpm ui:dev` till en fjärr-Gateway), lägg till UI
  ursprung till `gateway.controlUi.allowedOrigins`.

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
