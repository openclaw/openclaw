---
summary: "Android app (node): runbook ng koneksyon + Canvas/Chat/Camera"
read_when:
  - Pag-pair o muling pagkonekta ng Android node
  - Pag-debug ng Android gateway discovery o auth
  - Pag-verify ng parity ng chat history sa iba’t ibang client
title: "Android App"
x-i18n:
  source_path: platforms/android.md
  source_hash: 0f6aacdb2bc50354
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:45Z
---

# Android App (Node)

## Support snapshot

- Role: companion node app (hindi nagho-host ng Gateway ang Android).
- Kailangan ang Gateway: oo (patakbuhin sa macOS, Linux, o Windows via WSL2).
- Install: [Pagsisimula](/start/getting-started) + [Pairing](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [Konpigurasyon](/gateway/configuration).
  - Mga protocol: [Gateway protocol](/gateway/protocol) (nodes + control plane).

## System control

Ang system control (launchd/systemd) ay nasa host ng Gateway. Tingnan ang [Gateway](/gateway).

## Connection Runbook

Android node app ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Direktang kumokonekta ang Android sa Gateway WebSocket (default `ws://<host>:18789`) at gumagamit ng pairing na pagmamay-ari ng Gateway.

### Mga paunang kinakailangan

- Kaya mong patakbuhin ang Gateway sa “master” machine.
- Naabot ng Android device/emulator ang gateway WebSocket:
  - Parehong LAN na may mDNS/NSD, **o**
  - Parehong Tailscale tailnet gamit ang Wide-Area Bonjour / unicast DNS-SD (tingnan sa ibaba), **o**
  - Manual na gateway host/port (fallback)
- Kaya mong patakbuhin ang CLI (`openclaw`) sa gateway machine (o via SSH).

### 1) Simulan ang Gateway

```bash
openclaw gateway --port 18789 --verbose
```

Kumpirmahin sa logs na may makikita kang ganito:

- `listening on ws://0.0.0.0:18789`

Para sa tailnet-only setups (inirerekomenda para sa Vienna ⇄ London), i-bind ang gateway sa tailnet IP:

- Itakda ang `gateway.bind: "tailnet"` sa `~/.openclaw/openclaw.json` sa host ng Gateway.
- I-restart ang Gateway / macOS menubar app.

### 2) I-verify ang discovery (opsyonal)

Mula sa gateway machine:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Karagdagang tala sa pag-debug: [Bonjour](/gateway/bonjour).

#### Tailnet (Vienna ⇄ London) discovery via unicast DNS-SD

Hindi tatawid ng mga network ang Android NSD/mDNS discovery. Kung ang Android node at ang gateway ay nasa magkaibang network pero konektado via Tailscale, gamitin ang Wide-Area Bonjour / unicast DNS-SD sa halip:

1. Mag-set up ng DNS-SD zone (halimbawa `openclaw.internal.`) sa host ng Gateway at i-publish ang mga record na `_openclaw-gw._tcp`.
2. I-configure ang Tailscale split DNS para sa napiling domain na tumuturo sa DNS server na iyon.

Mga detalye at halimbawa ng CoreDNS config: [Bonjour](/gateway/bonjour).

### 3) Kumonekta mula sa Android

Sa Android app:

- Pinananatiling buhay ng app ang koneksyon sa gateway sa pamamagitan ng **foreground service** (persistent notification).
- Buksan ang **Settings**.
- Sa ilalim ng **Discovered Gateways**, piliin ang iyong gateway at pindutin ang **Connect**.
- Kung naka-block ang mDNS, gamitin ang **Advanced → Manual Gateway** (host + port) at **Connect (Manual)**.

Pagkatapos ng unang matagumpay na pairing, awtomatikong magre-reconnect ang Android sa launch:

- Manual endpoint (kung naka-enable), kung hindi
- Ang huling nadiskubreng gateway (best-effort).

### 4) Aprubahan ang pairing (CLI)

Sa gateway machine:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Mga detalye ng pairing: [Gateway pairing](/gateway/pairing).

### 5) I-verify na nakakonekta ang node

- Via status ng nodes:

  ```bash
  openclaw nodes status
  ```

- Via Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) Chat + history

Ginagamit ng Chat sheet ng Android node ang **primary session key** ng gateway (`main`), kaya ibinabahagi ang history at mga reply sa WebChat at iba pang client:

- History: `chat.history`
- Send: `chat.send`
- Push updates (best-effort): `chat.subscribe` → `event:"chat"`

### 7) Canvas + camera

#### Gateway Canvas Host (inirerekomenda para sa web content)

Kung gusto mong magpakita ang node ng totoong HTML/CSS/JS na puwedeng i-edit ng agent sa disk, ituro ang node sa Gateway canvas host.

Tandaan: gumagamit ang mga node ng standalone canvas host sa `canvasHost.port` (default `18793`).

1. Gumawa ng `~/.openclaw/workspace/canvas/index.html` sa host ng Gateway.

2. I-navigate ang node dito (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (opsyonal): kung parehong nasa Tailscale ang dalawang device, gumamit ng MagicDNS name o tailnet IP sa halip na `.local`, hal. `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Nag-i-inject ang server na ito ng live-reload client sa HTML at nagre-reload kapag may pagbabago sa file.
Ang A2UI host ay nasa `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Mga command ng Canvas (foreground lamang):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (gamitin ang `{"url":""}` o `{"url":"/"}` para bumalik sa default scaffold). Ibinabalik ng `canvas.snapshot` ang `{ format, base64 }` (default `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` legacy alias)

Mga command ng camera (foreground lamang; may permission gate):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

Tingnan ang [Camera node](/nodes/camera) para sa mga parameter at CLI helpers.
