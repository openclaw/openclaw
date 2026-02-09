---
summary: "daloy ng macOS app para sa pagkontrol ng remote na OpenClaw gateway sa pamamagitan ng SSH"
read_when:
  - Pagse-set up o pag-debug ng remote mac control
title: "Remote Control"
---

# Remote OpenClaw (macOS ⇄ remote host)

This flow lets the macOS app act as a full remote control for a OpenClaw gateway running on another host (desktop/server). It’s the app’s **Remote over SSH** (remote run) feature. All features—health checks, Voice Wake forwarding, and Web Chat—reuse the same remote SSH configuration from _Settings → General_.

## Mga mode

- **Local (this Mac)**: Everything runs on the laptop. No SSH involved.
- **Remote over SSH (default)**: OpenClaw commands are executed on the remote host. The mac app opens an SSH connection with `-o BatchMode` plus your chosen identity/key and a local port-forward.
- **Remote direct (ws/wss)**: No SSH tunnel. The mac app connects to the gateway URL directly (for example, via Tailscale Serve or a public HTTPS reverse proxy).

## Mga remote transport

Sinusuportahan ng remote mode ang dalawang transport:

- **SSH tunnel** (default): Uses `ssh -N -L ...` to forward the gateway port to localhost. The gateway will see the node’s IP as `127.0.0.1` because the tunnel is loopback.
- **Direct (ws/wss)**: Connects straight to the gateway URL. The gateway sees the real client IP.

## Mga paunang kinakailangan sa remote host

1. I-install ang Node + pnpm at i-build/i-install ang OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
2. Tiyaking ang `openclaw` ay nasa PATH para sa mga non-interactive shell (mag-symlink sa `/usr/local/bin` o `/opt/homebrew/bin` kung kailangan).
3. Open SSH with key auth. We recommend **Tailscale** IPs for stable reachability off-LAN.

## Setup ng macOS app

1. Buksan ang _Settings → General_.
2. Sa ilalim ng **OpenClaw runs**, piliin ang **Remote over SSH** at itakda ang:
   - **Transport**: **SSH tunnel** o **Direct (ws/wss)**.
   - **SSH target**: `user@host` (opsyonal ang `:port`).
     - Kung ang gateway ay nasa parehong LAN at nag-a-advertise ng Bonjour, piliin ito mula sa discovered list para awtomatikong mapunan ang field na ito.
   - **Gateway URL** (Direct lamang): `wss://gateway.example.ts.net` (o `ws://...` para sa local/LAN).
   - **Identity file** (advanced): path papunta sa iyong key.
   - **Project root** (advanced): remote checkout path na ginagamit para sa mga command.
   - **CLI path** (advanced): opsyonal na path sa isang runnable na `openclaw` entrypoint/binary (awtomatikong napupunan kapag na-advertise).
3. Hit **Test remote**. Success indicates the remote `openclaw status --json` runs correctly. Failures usually mean PATH/CLI issues; exit 127 means the CLI isn’t found remotely.
4. Ang health checks at Web Chat ay tatakbo na ngayon sa pamamagitan ng SSH tunnel na ito nang awtomatiko.

## Web Chat

- **SSH tunnel**: Kumokonekta ang Web Chat sa gateway sa pamamagitan ng forwarded WebSocket control port (default 18789).
- **Direct (ws/wss)**: Direktang kumokonekta ang Web Chat sa naka-configure na gateway URL.
- Wala nang hiwalay na WebChat HTTP server.

## Mga pahintulot

- Kailangan ng remote host ang parehong mga TCC approval tulad ng lokal (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Run onboarding on that machine to grant them once.
- Ina-advertise ng mga node ang kanilang permission state sa pamamagitan ng `node.list` / `node.describe` para malaman ng mga agent kung ano ang available.

## Mga tala sa seguridad

- Mas mainam ang loopback binds sa remote host at kumonekta sa pamamagitan ng SSH o Tailscale.
- Kung i-bind mo ang Gateway sa isang non-loopback interface, mag-require ng token/password auth.
- Tingnan ang [Security](/gateway/security) at [Tailscale](/gateway/tailscale).

## WhatsApp login flow (remote)

- Run `openclaw channels login --verbose` **on the remote host**. Scan the QR with WhatsApp on your phone.
- Patakbuhin muli ang pag-login sa host na iyon kung mag-expire ang auth. 8. Ilalabas ng health check ang mga problema sa link.

## Pag-troubleshoot

- 9. **exit 127 / not found**: wala ang `openclaw` sa PATH para sa mga non-login shell. Add it to `/etc/paths`, your shell rc, or symlink into `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: suriin ang SSH reachability, PATH, at kung naka-login ang Baileys (`openclaw status --json`).
- **Web Chat stuck**: tiyaking tumatakbo ang gateway sa remote host at tugma ang forwarded port sa gateway WS port; nangangailangan ang UI ng healthy na WS connection.
- **Node IP shows 127.0.0.1**: expected with the SSH tunnel. Switch **Transport** to **Direct (ws/wss)** if you want the gateway to see the real client IP.
- **Voice Wake**: awtomatikong nafi-forward ang mga trigger phrase sa remote mode; walang hiwalay na forwarder na kailangan.

## Mga tunog ng notification

Pumili ng mga tunog kada notification mula sa mga script gamit ang `openclaw` at `node.invoke`, hal.:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Wala nang global na toggle para sa “default sound” sa app; ang mga tumatawag ang pumipili ng tunog (o wala) kada request.
