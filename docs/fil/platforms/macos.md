---
summary: "OpenClaw macOS companion app (menu bar + gateway broker)"
read_when:
  - Pagpapatupad ng mga feature ng macOS app
  - Pagbabago ng lifecycle ng gateway o node bridging sa macOS
title: "macOS App"
---

# OpenClaw macOS Companion (menu bar + gateway broker)

50. Ang macOS app ay ang **menu‑bar companion** para sa OpenClaw. It owns permissions,
    manages/attaches to the Gateway locally (launchd or manual), and exposes macOS
    capabilities to the agent as a node.

## Ano ang ginagawa nito

- Nagpapakita ng native notifications at status sa menu bar.
- Pinamamahalaan ang mga TCC prompt (Notifications, Accessibility, Screen Recording, Microphone,
  Speech Recognition, Automation/AppleScript).
- Pinapatakbo o kumokonekta sa Gateway (lokal o remote).
- Naglalantad ng macOS‑only tools (Canvas, Camera, Screen Recording, `system.run`).
- Sinisimulan ang local node host service sa **remote** mode (launchd), at hinihinto ito sa **local** mode.
- Opsyonal na nagho-host ng **PeekabooBridge** para sa UI automation.
- Ini-install ang global CLI (`openclaw`) via npm/pnpm kapag hiniling (hindi inirerekomenda ang bun para sa Gateway runtime).

## Local vs remote mode

- **Local** (default): ina-attach ng app ang sarili sa tumatakbong lokal na Gateway kung mayroon;
  kung wala, pinapagana nito ang launchd service via `openclaw gateway install`.
- **Remote**: kumokonekta ang app sa isang Gateway sa pamamagitan ng SSH/Tailscale at hindi kailanman nagsisimula ng lokal na proseso.
  Sinisimulan ng app ang lokal na **node host service** upang maabot ng remote Gateway ang Mac na ito.
  The app does not spawn the Gateway as a child process.

## Launchd control

The app manages a per‑user LaunchAgent labeled `bot.molt.gateway`
(or `bot.molt.<profile>` when using `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` still unloads).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Palitan ang label ng `bot.molt.<profile>` kapag nagpapatakbo ng isang pinangalanang profile.

Kung hindi naka-install ang LaunchAgent, paganahin ito mula sa app o patakbuhin ang
`openclaw gateway install`.

## Node capabilities (mac)

Ipinapakita ng macOS app ang sarili nito bilang isang node. Mga karaniwang command:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

Nagre-report ang node ng isang `permissions` map para makapagpasya ang mga agent kung ano ang pinapayagan.

Node service + app IPC:

- Kapag tumatakbo ang headless node host service (remote mode), kumokonekta ito sa Gateway WS bilang isang node.
- Ang `system.run` ay isinasagawa sa macOS app (UI/TCC context) sa ibabaw ng lokal na Unix socket; nananatili sa app ang mga prompt at output.

Diagram (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec approvals (system.run)

`system.run` ay kinokontrol ng **Exec approvals** sa macOS app (Settings → Exec approvals).
Security + ask + allowlist are stored locally on the Mac in:

```
~/.openclaw/exec-approvals.json
```

Halimbawa:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Mga tala:

- Ang mga `allowlist` entry ay mga glob pattern para sa resolved binary paths.
- Ang pagpili ng “Always Allow” sa prompt ay nagdadagdag ng command na iyon sa allowlist.
- Ang mga `system.run` environment override ay sinasala (inaalis ang `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) at pagkatapos ay pinagsasama sa environment ng app.

## Deep links

Nirehistro ng app ang `openclaw://` URL scheme para sa mga lokal na aksyon.

### `openclaw://agent`

Nagti-trigger ng isang Gateway `agent` request.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Mga query parameter:

- `message` (kinakailangan)
- `sessionKey` (opsyonal)
- `thinking` (opsyonal)
- `deliver` / `to` / `channel` (opsyonal)
- `timeoutSeconds` (opsyonal)
- `key` (opsyonal na unattended mode key)

Kaligtasan:

- Kung walang `key`, hihingi ang app ng kumpirmasyon.
- Kapag may valid na `key`, ang pagtakbo ay unattended (nilalayong gamitin para sa personal automations).

## Onboarding flow (karaniwan)

1. I-install at ilunsad ang **OpenClaw.app**.
2. Kumpletuhin ang permissions checklist (TCC prompts).
3. Tiyaking aktibo ang **Local** mode at tumatakbo ang Gateway.
4. I-install ang CLI kung gusto mo ng access sa terminal.

## Build & dev workflow (native)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (o Xcode)
- I-package ang app: `scripts/package-mac-app.sh`

## Debug gateway connectivity (macOS CLI)

Gamitin ang debug CLI para subukan ang parehong Gateway WebSocket handshake at discovery
logic na ginagamit ng macOS app, nang hindi inilulunsad ang app.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Mga opsyon sa koneksyon:

- `--url <ws://host:port>`: i-override ang config
- `--mode <local|remote>`: i-resolve mula sa config (default: config o local)
- `--probe`: pilitin ang sariwang health probe
- `--timeout <ms>`: timeout ng request (default: `15000`)
- `--json`: structured output para sa diffing

Mga opsyon sa discovery:

- `--include-local`: isama ang mga gateway na sasalain bilang “local”
- `--timeout <ms>`: pangkalahatang discovery window (default: `2000`)
- `--json`: structured output para sa diffing

Tip: ikumpara laban sa `openclaw gateway discover --json` para makita kung naiiba ang
discovery pipeline ng macOS app (NWBrowser + tailnet DNS‑SD fallback) kumpara sa
`dns-sd`‑based discovery ng Node CLI.

## Remote connection plumbing (SSH tunnels)

Kapag tumatakbo ang macOS app sa **Remote** mode, nagbubukas ito ng SSH tunnel para makausap ng mga lokal na UI
component ang remote Gateway na parang nasa localhost ito.

### Control tunnel (Gateway WebSocket port)

- **Layunin:** health checks, status, Web Chat, config, at iba pang control‑plane calls.
- **Local port:** ang Gateway port (default `18789`), palaging stable.
- **Remote port:** ang parehong Gateway port sa remote host.
- **Pag-uugali:** walang random na local port; nire-reuse ng app ang umiiral na healthy tunnel
  o nire-restart ito kapag kinakailangan.
- **SSH shape:** `ssh -N -L <local>:127.0.0.1:<remote>` na may BatchMode +
  ExitOnForwardFailure + keepalive options.
- **IP reporting:** the SSH tunnel uses loopback, so the gateway will see the node
  IP as `127.0.0.1`. Gamitin ang **Direct (ws/wss)** transport kung gusto mong lumabas ang tunay na client IP (tingnan ang [macOS remote access](/platforms/mac/remote)).

Para sa mga hakbang sa setup, tingnan ang [macOS remote access](/platforms/mac/remote). Para sa mga detalye ng protocol, tingnan ang [Gateway protocol](/gateway/protocol).

## Related docs

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS permissions](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
