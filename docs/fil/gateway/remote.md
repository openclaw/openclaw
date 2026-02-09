---
summary: "Remote na access gamit ang SSH tunnels (Gateway WS) at mga tailnet"
read_when:
  - Kapag nagpapatakbo o nagti-troubleshoot ng mga remote gateway setup
title: "Remote Access"
---

# Remote na access (SSH, mga tunnel, at mga tailnet)

Sinusuportahan ng repo na ito ang “remote over SSH” sa pamamagitan ng pagpapanatiling tumatakbo ang isang Gateway (ang master) sa isang dedikadong host (desktop/server) at pagkonekta ng mga client dito.

- Para sa **mga operator (ikaw / ang macOS app)**: ang SSH tunneling ang pangkalahatang fallback.
- Para sa **mga node (iOS/Android at mga susunod na device)**: kumonekta sa **Gateway WebSocket** (LAN/tailnet o SSH tunnel kung kinakailangan).

## Ang pangunahing ideya

- Ang Gateway WebSocket ay naka-bind sa **loopback** sa iyong naka-configure na port (default ay 18789).
- Para sa remote na paggamit, ipinapasa mo ang loopback port na iyon sa SSH (o gumamit ng tailnet/VPN at bawasan ang tunneling).

## Mga karaniwang VPN/tailnet setup (kung saan nakatira ang agent)

Think of the **Gateway host** as “where the agent lives.” It owns sessions, auth profiles, channels, and state.
Your laptop/desktop (and nodes) connect to that host.

### 1. Palaging-on na Gateway sa iyong tailnet (VPS o home server)

Patakbuhin ang Gateway sa isang persistent na host at i-access ito sa pamamagitan ng **Tailscale** o SSH.

- **Pinakamahusay na UX:** panatilihin ang `gateway.bind: "loopback"` at gamitin ang **Tailscale Serve** para sa Control UI.
- **Fallback:** panatilihin ang loopback + SSH tunnel mula sa anumang machine na nangangailangan ng access.
- **Mga halimbawa:** [exe.dev](/install/exe-dev) (madaling VM) o [Hetzner](/install/hetzner) (production VPS).

Mainam ito kapag madalas matulog ang iyong laptop pero gusto mong laging naka-on ang agent.

### 2. Home desktop ang nagpapatakbo ng Gateway, laptop ang remote control

The laptop does **not** run the agent. It connects remotely:

- Gamitin ang **Remote over SSH** mode ng macOS app (Settings → General → “OpenClaw runs”).
- Ang app ang nagbubukas at namamahala ng tunnel, kaya ang WebChat + mga health check ay “gumagana na lang.”

Runbook: [macOS remote access](/platforms/mac/remote).

### 3. Laptop ang nagpapatakbo ng Gateway, remote access mula sa ibang machine

Panatilihing local ang Gateway pero ilantad ito nang ligtas:

- SSH tunnel papunta sa laptop mula sa ibang machine, o
- I-Tailscale Serve ang Control UI at panatilihing loopback-only ang Gateway.

Gabay: [Tailscale](/gateway/tailscale) at [Web overview](/web).

## Daloy ng command (ano ang tumatakbo saan)

One gateway service owns state + channels. Nodes are peripherals.

Halimbawang daloy (Telegram → node):

- Dumarating ang mensahe ng Telegram sa **Gateway**.
- Pinapatakbo ng Gateway ang **agent** at nagpapasya kung tatawag ng node tool.
- Tinatawagan ng Gateway ang **node** sa pamamagitan ng Gateway WebSocket (`node.*` RPC).
- Ibinabalik ng node ang resulta; sumasagot pabalik ang Gateway sa Telegram.

Mga tala:

- **Hindi nagpapatakbo ng gateway service ang mga node.** Isang gateway lang ang dapat tumakbo bawat host maliban kung sadyang nagpapatakbo ka ng mga hiwalay na profile (tingnan ang [Multiple gateways](/gateway/multiple-gateways)).
- Ang macOS app na “node mode” ay isa lamang node client sa ibabaw ng Gateway WebSocket.

## SSH tunnel (CLI + mga tool)

Gumawa ng local tunnel papunta sa remote Gateway WS:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Kapag naka-up ang tunnel:

- Ang `openclaw health` at `openclaw status --deep` ay maaabot na ang remote gateway sa pamamagitan ng `ws://127.0.0.1:18789`.
- Ang `openclaw gateway {status,health,send,agent,call}` ay maaari ring tumarget sa forwarded URL sa pamamagitan ng `--url` kapag kinakailangan.

Note: replace `18789` with your configured `gateway.port` (or `--port`/`OPENCLAW_GATEWAY_PORT`).
Note: when you pass `--url`, the CLI does not fall back to config or environment credentials.
Include `--token` or `--password` explicitly. Missing explicit credentials is an error.

## Mga default ng CLI para sa remote

Maaari kang magpanatili ng remote target upang gamitin ito ng mga CLI command bilang default:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Kapag loopback-only ang gateway, panatilihin ang URL sa `ws://127.0.0.1:18789` at buksan muna ang SSH tunnel.

## Chat UI sa ibabaw ng SSH

WebChat no longer uses a separate HTTP port. The SwiftUI chat UI connects directly to the Gateway WebSocket.

- I-forward ang `18789` sa SSH (tingnan sa itaas), pagkatapos ay ikonekta ang mga client sa `ws://127.0.0.1:18789`.
- Sa macOS, mas mainam ang “Remote over SSH” mode ng app, na awtomatikong namamahala ng tunnel.

## macOS app na “Remote over SSH”

Maaaring patakbuhin ng macOS menu bar app ang parehong setup mula simula hanggang dulo (mga remote status check, WebChat, at Voice Wake forwarding).

Runbook: [macOS remote access](/platforms/mac/remote).

## Mga patakaran sa seguridad (remote/VPN)

Maikling bersyon: **panatilihing loopback-only ang Gateway** maliban kung sigurado kang kailangan mo ng bind.

- **Loopback + SSH/Tailscale Serve** ang pinakaligtas na default (walang public exposure).
- Ang **non-loopback bind** (`lan`/`tailnet`/`custom`, o `auto` kapag hindi available ang loopback) ay dapat gumamit ng mga auth token/password.
- Ang `gateway.remote.token` ay **para lamang** sa mga remote CLI call — **hindi** nito ine-enable ang local auth.
- Ang `gateway.remote.tlsFingerprint` ay nagpi-pin ng remote TLS cert kapag gumagamit ng `wss://`.
- **Tailscale Serve** can authenticate via identity headers when `gateway.auth.allowTailscale: true`.
  Set it to `false` if you want tokens/passwords instead.
- Ituring ang browser control na parang operator access: tailnet-only + sinadyang node pairing.

Mas malalim na talakayan: [Security](/gateway/security).
