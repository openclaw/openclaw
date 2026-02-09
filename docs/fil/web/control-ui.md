---
summary: "UI ng kontrol na nakabatay sa browser para sa Gateway (chat, mga node, config)"
read_when:
  - Gusto mong patakbuhin ang Gateway mula sa isang browser
  - Gusto mo ng Tailnet access nang walang SSH tunnels
title: "Control UI"
---

# Control UI (browser)

Ang Control UI ay isang maliit na **Vite + Lit** single-page app na sini-serve ng Gateway:

- default: `http://<host>:18789/`
- optional na prefix: itakda ang `gateway.controlUi.basePath` (hal. `/openclaw`)

Direkta itong nakikipag-usap sa **Gateway WebSocket** sa parehong port.

## Mabilis na pagbukas (local)

Kung tumatakbo ang Gateway sa parehong computer, buksan:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (o [http://localhost:18789/](http://localhost:18789/))

Kung hindi mag-load ang page, simulan muna ang Gateway: `openclaw gateway`.

Ibinibigay ang auth sa panahon ng WebSocket handshake sa pamamagitan ng:

- `connect.params.auth.token`
- `connect.params.auth.password`
  Pinapayagan ka ng settings panel ng dashboard na mag-imbak ng token; hindi sini-save ang mga password.
  Ang onboarding wizard ay bumubuo ng gateway token bilang default, kaya i-paste ito rito sa unang pag-connect.

## Device pairing (unang koneksyon)

Kapag kumonekta ka sa Control UI mula sa bagong browser o device, ang Gateway ay
nangangailangan ng **one-time pairing approval** — kahit na nasa parehong Tailnet ka
na may `gateway.auth.allowTailscale: true`. Isa itong hakbang sa seguridad upang maiwasan ang
hindi awtorisadong pag-access.

**Makikita mo:** "disconnected (1008): pairing required"

**Para aprubahan ang device:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Kapag naaprubahan na, matatandaan ang device at hindi na mangangailangan ng muling pag-apruba maliban kung bawiin mo ito gamit ang `openclaw devices revoke --device <id> --role <role>`. Tingnan ang
[Devices CLI](/cli/devices) para sa token rotation at revocation.

**Mga tala:**

- Ang mga local na koneksyon (`127.0.0.1`) ay auto-approved.
- Mga remote na koneksyon (LAN, Tailnet, atbp.) nangangailangan ng tahasang pag-apruba.
- Bawat browser profile ay gumagawa ng natatanging device ID, kaya ang pagpapalit ng browser o
  pag-clear ng browser data ay mangangailangan ng muling pairing.

## Ano ang kaya nitong gawin (sa ngayon)

- Makipag-chat sa model sa pamamagitan ng Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Mag-stream ng mga tool call + live na tool output cards sa Chat (agent events)
- Mga channel: WhatsApp/Telegram/Discord/Slack + mga plugin channel (Mattermost, atbp.) status + QR login + per-channel na config (`channels.status`, `web.login.*`, `config.patch`)
- Mga instance: presence list + refresh (`system-presence`)
- Mga session: listahan + per-session thinking/verbose overrides (`sessions.list`, `sessions.patch`)
- Mga cron job: list/add/run/enable/disable + run history (`cron.*`)
- Skills: status, enable/disable, install, pag-update ng API key (`skills.*`)
- Mga node: listahan + caps (`node.list`)
- Exec approvals: i-edit ang gateway o node allowlists + humingi ng policy para sa `exec host=gateway/node` (`exec.approvals.*`)
- Config: tingnan/i-edit ang `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Config: apply + restart na may validation (`config.apply`) at gisingin ang huling aktibong session
- Kasama sa mga write ng config ang base-hash guard para maiwasan ang pag-clobber ng sabayang mga edit
- Config schema + form rendering (`config.schema`, kasama ang plugin + channel schemas); nananatiling available ang Raw JSON editor
- Debug: mga snapshot ng status/health/models + event log + manual RPC calls (`status`, `health`, `models.list`)
- Logs: live tail ng gateway file logs na may filter/export (`logs.tail`)
- Update: magpatakbo ng package/git update + restart (`update.run`) na may restart report

Mga tala sa panel ng cron jobs:

- Para sa mga isolated na trabaho, ang default na delivery ay ang pag-anunsyo ng buod. Maaari kang lumipat sa none kung gusto mo ng internal-only na mga run.
- Lalabas ang mga field na channel/target kapag napili ang announce.

## Asal ng chat

- Ang `chat.send` ay **non-blocking**: agad itong nag-a-ack gamit ang `{ runId, status: "started" }` at ang sagot ay nag-i-stream sa pamamagitan ng mga event na `chat`.
- Ang muling pagpapadala na may parehong `idempotencyKey` ay magbabalik ng `{ status: "in_flight" }` habang tumatakbo, at `{ status: "ok" }` matapos makumpleto.
- Ang `chat.inject` ay nagdadagdag ng assistant note sa session transcript at nagbo-broadcast ng `chat` event para sa UI-only na mga update (walang agent run, walang channel delivery).
- Stop:
  - I-click ang **Stop** (tumatawag sa `chat.abort`)
  - I-type ang `/stop` (o `stop|esc|abort|wait|exit|interrupt`) para mag-abort out-of-band
  - Ang `chat.abort` ay sumusuporta sa `{ sessionKey }` (walang `runId`) para i-abort ang lahat ng aktibong run para sa session na iyon

## Tailnet access (inirerekomenda)

### Integrated Tailscale Serve (mas mainam)

Panatilihin ang Gateway sa loopback at hayaang i-proxy ito ng Tailscale Serve gamit ang HTTPS:

```bash
openclaw gateway --tailscale serve
```

Buksan:

- `https://<magicdns>/` (o ang naka-configure mong `gateway.controlUi.basePath`)

Bilang default, ang mga Serve request ay maaaring mag-authenticate sa pamamagitan ng Tailscale identity headers
(`tailscale-user-login`) kapag ang `gateway.auth.allowTailscale` ay `true`. Bini-verify ng OpenClaw ang identidad sa pamamagitan ng pag-resolve ng `x-forwarded-for` address gamit ang
`tailscale whois` at pagtutugma nito sa header, at tinatanggap lamang ang mga ito kapag ang request ay tumatama sa loopback na may mga `x-forwarded-*` header ng Tailscale. Itakda ang
`gateway.auth.allowTailscale: false` (o pilitin ang `gateway.auth.mode: "password"`)
kung gusto mong mangailangan ng token/password kahit para sa Serve traffic.

### Bind sa tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Pagkatapos ay buksan:

- `http://<tailscale-ip>:18789/` (o ang naka-configure mong `gateway.controlUi.basePath`)

I-paste ang token sa settings ng UI (ipinapadala bilang `connect.params.auth.token`).

## Insecure HTTP

Kung bubuksan mo ang dashboard gamit ang plain HTTP (`http://<lan-ip>` o `http://<tailscale-ip>`),
tatakbo ang browser sa isang **non-secure context** at haharangan ang WebCrypto. Bilang default,
**binablock** ng OpenClaw ang mga koneksyon ng Control UI na walang device identity.

**Inirerekomendang ayos:** gumamit ng HTTPS (Tailscale Serve) o buksan ang UI nang lokal:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (sa host ng Gateway)

**Halimbawa ng downgrade (token-only sa HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

Pinapagana nito ang pag-disable ng device identity + pairing para sa Control UI (kahit sa HTTPS). Gamitin
lamang kung pinagkakatiwalaan mo ang network.

Tingnan ang [Tailscale](/gateway/tailscale) para sa gabay sa pag-setup ng HTTPS.

## Pagbuo ng UI

Nagsi-serve ang Gateway ng mga static file mula sa `dist/control-ui`. Buuin ang mga ito gamit ang:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Opsyonal na absolute base (kapag gusto mo ng fixed asset URLs):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Para sa local development (hiwalay na dev server):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Pagkatapos ay ituro ang UI sa iyong Gateway WS URL (hal. `ws://127.0.0.1:18789`).

## Debugging/testing: dev server + remote Gateway

Ang Control UI ay mga static file; ang WebSocket target ay configurable at maaaring
iba sa HTTP origin. Kapaki-pakinabang ito kapag gusto mo ang Vite dev server
lokal ngunit tumatakbo ang Gateway sa ibang lugar.

1. Simulan ang UI dev server: `pnpm ui:dev`
2. Magbukas ng URL tulad ng:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Opsyonal na one-time auth (kung kailangan):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Mga tala:

- Ang `gatewayUrl` ay ini-store sa localStorage pagkatapos mag-load at inaalis mula sa URL.
- Ang `token` ay ini-store sa localStorage; ang `password` ay pinananatili lamang sa memory.
- Kapag nakatakda ang `gatewayUrl`, hindi na babalik ang UI sa config o environment credentials.
  Ibigay ang `token` (o `password`) nang tahasan. Ang kawalan ng tahasang credentials ay isang error.
- Gamitin ang `wss://` kapag ang Gateway ay nasa likod ng TLS (Tailscale Serve, HTTPS proxy, atbp.).
- Ang `gatewayUrl` ay tinatanggap lamang sa isang top-level window (hindi embedded) upang maiwasan ang clickjacking.
- Para sa mga cross-origin dev setup (hal. `pnpm ui:dev` patungo sa isang remote Gateway), idagdag ang UI
  origin sa `gateway.controlUi.allowedOrigins`.

Halimbawa:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Mga detalye ng setup para sa remote access: [Remote access](/gateway/remote).
