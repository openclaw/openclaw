---
summary: "daloy ng macOS app para sa pagkontrol ng remote na OpenClaw gateway sa pamamagitan ng SSH"
read_when:
  - Pagse-set up o pag-debug ng remote mac control
title: "Remote Control"
x-i18n:
  source_path: platforms/mac/remote.md
  source_hash: 61b43707250d5515
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:45Z
---

# Remote OpenClaw (macOS ⇄ remote host)

Pinapahintulutan ng daloy na ito ang macOS app na kumilos bilang ganap na remote control para sa isang OpenClaw gateway na tumatakbo sa ibang host (desktop/server). Ito ang feature ng app na **Remote over SSH** (remote run). Lahat ng feature—health checks, pag-forward ng Voice Wake, at Web Chat—ay gumagamit ng parehong remote SSH configuration mula sa _Settings → General_.

## Mga mode

- **Local (this Mac)**: Lahat ay tumatakbo sa laptop. Walang SSH.
- **Remote over SSH (default)**: Ang mga OpenClaw command ay isinasagawa sa remote host. Nagbubukas ang mac app ng SSH connection gamit ang `-o BatchMode` kasama ang napili mong identity/key at isang local port-forward.
- **Remote direct (ws/wss)**: Walang SSH tunnel. Direktang kumokonekta ang mac app sa gateway URL (hal., sa pamamagitan ng Tailscale Serve o isang public HTTPS reverse proxy).

## Mga remote transport

Sinusuportahan ng remote mode ang dalawang transport:

- **SSH tunnel** (default): Gumagamit ng `ssh -N -L ...` para i-forward ang gateway port papunta sa localhost. Makikita ng gateway ang IP ng node bilang `127.0.0.1` dahil loopback ang tunnel.
- **Direct (ws/wss)**: Direktang kumokonekta sa gateway URL. Nakikita ng gateway ang totoong client IP.

## Mga paunang kinakailangan sa remote host

1. I-install ang Node + pnpm at i-build/i-install ang OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).
2. Tiyaking ang `openclaw` ay nasa PATH para sa mga non-interactive shell (mag-symlink sa `/usr/local/bin` o `/opt/homebrew/bin` kung kailangan).
3. Buksan ang SSH na may key auth. Inirerekomenda namin ang **Tailscale** IPs para sa matatag na reachability sa labas ng LAN.

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
3. Pindutin ang **Test remote**. Ang tagumpay ay indikasyon na tumatakbo nang tama ang remote na `openclaw status --json`. Karaniwang nangangahulugan ang mga failure ng mga isyu sa PATH/CLI; ang exit 127 ay nangangahulugang hindi makita ang CLI sa remote.
4. Ang health checks at Web Chat ay tatakbo na ngayon sa pamamagitan ng SSH tunnel na ito nang awtomatiko.

## Web Chat

- **SSH tunnel**: Kumokonekta ang Web Chat sa gateway sa pamamagitan ng forwarded WebSocket control port (default 18789).
- **Direct (ws/wss)**: Direktang kumokonekta ang Web Chat sa naka-configure na gateway URL.
- Wala nang hiwalay na WebChat HTTP server.

## Mga pahintulot

- Kailangan ng remote host ang parehong TCC approvals gaya ng local (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Patakbuhin ang onboarding sa makinang iyon para maibigay ang mga ito nang isang beses.
- Ina-advertise ng mga node ang kanilang permission state sa pamamagitan ng `node.list` / `node.describe` para malaman ng mga agent kung ano ang available.

## Mga tala sa seguridad

- Mas mainam ang loopback binds sa remote host at kumonekta sa pamamagitan ng SSH o Tailscale.
- Kung i-bind mo ang Gateway sa isang non-loopback interface, mag-require ng token/password auth.
- Tingnan ang [Security](/gateway/security) at [Tailscale](/gateway/tailscale).

## WhatsApp login flow (remote)

- Patakbuhin ang `openclaw channels login --verbose` **sa remote host**. I-scan ang QR gamit ang WhatsApp sa iyong phone.
- Patakbuhin muli ang login sa host na iyon kung mag-expire ang auth. Ilalabas ng health check ang mga problema sa link.

## Pag-troubleshoot

- **exit 127 / not found**: Ang `openclaw` ay wala sa PATH para sa mga non-login shell. Idagdag ito sa `/etc/paths`, sa iyong shell rc, o mag-symlink sa `/usr/local/bin`/`/opt/homebrew/bin`.
- **Health probe failed**: suriin ang SSH reachability, PATH, at kung naka-login ang Baileys (`openclaw status --json`).
- **Web Chat stuck**: tiyaking tumatakbo ang gateway sa remote host at tugma ang forwarded port sa gateway WS port; nangangailangan ang UI ng healthy na WS connection.
- **Node IP shows 127.0.0.1**: inaasahan ito kapag may SSH tunnel. Ilipat ang **Transport** sa **Direct (ws/wss)** kung gusto mong makita ng gateway ang totoong client IP.
- **Voice Wake**: awtomatikong nafi-forward ang mga trigger phrase sa remote mode; walang hiwalay na forwarder na kailangan.

## Mga tunog ng notification

Pumili ng mga tunog kada notification mula sa mga script gamit ang `openclaw` at `node.invoke`, hal.:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

Wala nang global na toggle para sa “default sound” sa app; ang mga tumatawag ang pumipili ng tunog (o wala) kada request.
