---
summary: "Mga Node: pag-pair, mga kakayahan, mga permiso, at mga helper ng CLI para sa canvas/camera/screen/system"
read_when:
  - Pagpa-pair ng iOS/Android na mga node sa isang gateway
  - Paggamit ng node canvas/camera para sa konteksto ng agent
  - Pagdaragdag ng mga bagong node command o CLI helper
title: "Mga Node"
---

# Mga Node

Ang isang **node** ay isang kasamang device (macOS/iOS/Android/headless) na kumokonekta sa Gateway **WebSocket** (kaparehong port ng mga operator) na may `role: "node"` at naglalantad ng command surface (hal. `canvas.*`, `camera.*`, `system.*`) sa pamamagitan ng `node.invoke`. Hindi sila nagpapatakbo ng gateway service.

Legacy transport: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; deprecated/inisyal na tinanggal para sa mga kasalukuyang node).

Maaari ring tumakbo ang macOS sa **node mode**: ang menubar app ay kumokonekta sa WS server ng Gateway at inilalantad ang lokal nitong mga canvas/camera command bilang isang node (kaya gumagana ang `openclaw nodes …` laban sa Mac na ito).

Mga tala:

- Ang mga node ay **mga peripheral**, hindi mga gateway. Hindi sila nagpapatakbo ng gateway service.
- Ang mga mensahe mula sa Telegram/WhatsApp/etc. ay dumarating sa **gateway**, hindi sa mga node.
- Runbook sa pag-troubleshoot: [/nodes/troubleshooting](/nodes/troubleshooting)

## Pag-pair + status

Gumamit ng **node host** kapag ang iyong Gateway ay tumatakbo sa isang makina at gusto mong maipatupad ang mga command sa iba pa. Aprubahan sa pamamagitan ng devices CLI (o UI).

Mabilis na CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Mga tala:

- Minamarkahan ng `nodes status` ang isang node bilang **paired** kapag kasama sa device pairing role nito ang `node`.
- Ang `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) ay hiwalay na gateway-owned na
  node pairing store; **hindi** nito hinaharangan ang WS `connect` handshake.

## Remote node host (system.run)

Kung ang Gateway ay naka-bind sa loopback (`gateway.bind=loopback`, default sa local mode),
hindi makakakonekta nang direkta ang mga remote node host. Nakikipag-usap pa rin ang modelo sa **gateway**; ipinapasa ng gateway ang mga `exec` call sa **node host** kapag napili ang `host=node`.

### Ano ang tumatakbo saan

- **Host ng Gateway**: tumatanggap ng mga mensahe, nagpapatakbo ng model, nagru-route ng mga tool call.
- **Host ng node**: nagsasagawa ng `system.run`/`system.which` sa makina ng node.
- **Mga pag-apruba**: ipinapatupad sa host ng node sa pamamagitan ng `~/.openclaw/exec-approvals.json`.

### Simulan ang isang node host (foreground)

Sa makina ng node:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Remote gateway sa pamamagitan ng SSH tunnel (loopback bind)

Ang mga exec approval ay **bawat node host**. Gumawa ng SSH tunnel at ituro ang
node host sa lokal na dulo ng tunnel.

Halimbawa (node host -> gateway host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Mga tala:

- Ang token ay `gateway.auth.token` mula sa gateway config (`~/.openclaw/openclaw.json` sa host ng gateway).
- Binabasa ng `openclaw node run` ang `OPENCLAW_GATEWAY_TOKEN` para sa auth.

### Simulan ang isang node host (service)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Pag-pair + pangalan

Sa host ng gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Mga opsyon sa pagpapangalan:

- `--display-name` sa `openclaw node run` / `openclaw node install` (nananatili sa `~/.openclaw/node.json` sa node).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway override).

### I-allowlist ang mga command

Naglalantad ang mga node ng `screen.record` (mp4). Magdagdag ng mga allowlist entry mula sa gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Nananatili ang mga pag-apruba sa host ng node sa `~/.openclaw/exec-approvals.json`.

### Ituro ang exec sa node

I-configure ang mga default (gateway config):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

O per session:

```
/exec host=node security=allowlist node=<id-or-name>
```

Kapag naitakda na, anumang `exec` call na may `host=node` ay tatakbo sa host ng node (napapailalim sa
allowlist/pag-apruba ng node).

Kaugnay:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Pag-invoke ng mga command

Low-level (raw RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

May mas mataas na antas na mga helper para sa karaniwang workflow na “bigyan ang agent ng MEDIA attachment”.

## Mga screenshot (canvas snapshots)

Kung ipinapakita ng node ang Canvas (WebView), ibinabalik ng `canvas.snapshot` ang `{ format, base64 }`.

CLI helper (nagsusulat sa isang temp file at nagpi-print ng `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Mga kontrol sa Canvas

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Mga tala:

- Tumatanggap ang `canvas present` ng mga URL o lokal na file path (`--target`), kasama ang opsyonal na `--x/--y/--width/--height` para sa pagpo-posisyon.
- Tumatanggap ang `canvas eval` ng inline JS (`--js`) o isang positional arg.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Mga tala:

- Tanging A2UI v0.8 JSONL ang suportado (tinanggihan ang v0.9/createSurface).

## Mga larawan + video (node camera)

Mga larawan (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Mga video clip (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Mga tala:

- Dapat ay **foregrounded** ang node para sa `canvas.*` at `camera.*` (ang mga background call ay nagbabalik ng `NODE_BACKGROUND_UNAVAILABLE`).
- Ang haba ng clip ay naka-clamp (kasalukuyang `<= 60s`) upang maiwasan ang sobrang laki na base64 payload.
- Magpapakita ang Android ng prompt para sa mga permiso na `CAMERA`/`RECORD_AUDIO` kapag posible; ang mga tinanggihang permiso ay magfa-fail gamit ang `*_PERMISSION_REQUIRED`.

## Mga screen recording (mga node)

Naglalantad ang mga node ng `screen.record` (mp4). Halimbawa:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Mga tala:

- Nangangailangan ang `screen.record` na naka-foreground ang node app.
- Ipapakita ng Android ang system screen-capture prompt bago mag-record.
- Ang mga screen recording ay naka-clamp sa `<= 60s`.
- Dinidi-disable ng `--no-audio` ang pag-capture ng mikropono (suportado sa iOS/Android; ang macOS ay gumagamit ng system capture audio).
- Gamitin ang `--screen <index>` upang pumili ng display kapag may maraming screen.

## Lokasyon (mga node)

Naglalantad ang mga node ng `location.get` kapag naka-enable ang Location sa settings.

CLI helper:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Mga tala:

- Ang Location ay **naka-off bilang default**.
- Ang “Always” ay nangangailangan ng permiso ng system; ang background fetch ay best-effort.
- Kasama sa response ang lat/lon, accuracy (metro), at timestamp.

## SMS (mga Android node)

Maaaring ilantad ng mga Android node ang `sms.send` kapag binigyan ng user ng **SMS** permission at sinusuportahan ng device ang telephony.

Low-level invoke:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Mga tala:

- Dapat tanggapin ang permission prompt sa Android device bago ma-advertise ang kakayahan.
- Ang mga Wi‑Fi-only na device na walang telephony ay hindi mag-aadvertise ng `sms.send`.

## Mga system command (node host / mac node)

Sa macOS node mode, ang `system.run` ay pinaghihigpitan ng mga exec approval sa macOS app (Settings → Exec approvals).
Ang ask/allowlist/full ay kumikilos nang pareho sa headless node host; ang mga tinanggihang prompt ay nagbabalik ng `SYSTEM_RUN_DENIED`.

Mga halimbawa:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Mga tala:

- Ibinabalik ng `system.run` ang stdout/stderr/exit code sa payload.
- Iginagalang ng `system.notify` ang estado ng notification permission sa macOS app.
- Sinusuportahan ng `system.run` ang `--cwd`, `--env KEY=VAL`, `--command-timeout`, at `--needs-screen-recording`.
- Sinusuportahan ng `system.notify` ang `--priority <passive|active|timeSensitive>` at `--delivery <system|overlay|auto>`.
- Tinatanggal ng mga macOS node ang mga override ng `PATH`; ang mga headless node host ay tumatanggap lamang ng `PATH` kapag ito ay nagpe-prepend sa node host PATH.
- Sa macOS node mode, ang `system.run` ay nililimitahan ng mga exec approval sa macOS app (Settings → Exec approvals).
  Ang Ask/allowlist/full ay kumikilos nang pareho gaya ng headless node host; ang mga tinanggihang prompt ay nagbabalik ng `SYSTEM_RUN_DENIED`.
- Sa headless node host, ang `system.run` ay naka-gate ng exec approvals (`~/.openclaw/exec-approvals.json`).

## Pagbubuklod ng exec sa node

Kapag maraming node ang available, maaari mong i‑bind ang exec sa isang partikular na node.
Itinatakda nito ang default na node para sa `exec host=node` (at maaaring i-override kada agent).

Global default:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

I-unset upang payagan ang anumang node:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Mapa ng mga permiso

Maaaring magsama ang mga node ng isang `permissions` na mapa sa `node.list` / `node.describe`, na naka-key sa pangalan ng permiso (hal. `screenRecording`, `accessibility`) na may mga boolean na value (`true` = granted).

## Headless node host (cross-platform)

Sa macOS, mas pinipili ng headless node host ang exec host ng companion app kapag maaabot at bumabagsak
pabalik sa lokal na pagpapatupad kung hindi available ang app. Itakda ang `OPENCLAW_NODE_EXEC_HOST=app` upang hingin
ang app, o `OPENCLAW_NODE_EXEC_FALLBACK=0` upang huwag paganahin ang fallback.

Simulan ito:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Mga tala:

- Kinakailangan pa rin ang pag-pair (magpapakita ang Gateway ng prompt ng pag-apruba ng node).
- Iniimbak ng node host ang node id, token, display name, at impormasyon ng koneksyon sa gateway sa `~/.openclaw/node.json`.
- Ang mga exec approval ay ipinapatupad nang lokal sa pamamagitan ng `~/.openclaw/exec-approvals.json`
  (tingnan ang [Exec approvals](/tools/exec-approvals)).
- Sa macOS, mas pinipili ng headless node host ang companion app exec host kapag naaabot at bumabagsak
  pabalik sa lokal na pag-execute kung hindi available ang app. Maaari kaming maglantad ng selector sa loob ng app, ngunit ang OS pa rin ang magpapasya sa aktwal na pagbibigay.
- Idagdag ang `--tls` / `--tls-fingerprint` kapag gumagamit ng TLS ang Gateway WS.

## Mac node mode

- Ang macOS menubar app ay kumokonekta sa Gateway WS server bilang isang node (kaya gumagana ang `openclaw nodes …` laban sa Mac na ito).
- Sa remote mode, nagbubukas ang app ng SSH tunnel para sa Gateway port at kumokonekta sa `localhost`.
