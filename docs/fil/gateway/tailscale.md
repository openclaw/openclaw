---
summary: "Integrated na Tailscale Serve/Funnel para sa Gateway dashboard"
read_when:
  - Paglalantad ng Gateway Control UI sa labas ng localhost
  - Pag-automate ng tailnet o pampublikong access sa dashboard
title: "Tailscale"
x-i18n:
  source_path: gateway/tailscale.md
  source_hash: c4842b10848d4fdd
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:39Z
---

# Tailscale (Gateway dashboard)

Kayang i-auto-configure ng OpenClaw ang Tailscale **Serve** (tailnet) o **Funnel** (pampubliko) para sa
Gateway dashboard at WebSocket port. Pinapanatili nitong naka-bind ang Gateway sa loopback habang
nagbibigay ang Tailscale ng HTTPS, routing, at (para sa Serve) mga identity header.

## Mga mode

- `serve`: Serve na tailnet-only sa pamamagitan ng `tailscale serve`. Nanatili ang gateway sa `127.0.0.1`.
- `funnel`: Pampublikong HTTPS sa pamamagitan ng `tailscale funnel`. Nangangailangan ang OpenClaw ng shared password.
- `off`: Default (walang Tailscale automation).

## Auth

Itakda ang `gateway.auth.mode` para kontrolin ang handshake:

- `token` (default kapag naka-set ang `OPENCLAW_GATEWAY_TOKEN`)
- `password` (shared secret sa pamamagitan ng `OPENCLAW_GATEWAY_PASSWORD` o config)

Kapag ang `tailscale.mode = "serve"` at ang `gateway.auth.allowTailscale` ay `true`,
maaaring mag-authenticate ang mga valid na Serve proxy request gamit ang mga Tailscale identity header
(`tailscale-user-login`) nang hindi nagbibigay ng token/password. Vine-verify ng OpenClaw
ang identity sa pamamagitan ng pag-resolve ng `x-forwarded-for` address gamit ang lokal na Tailscale
daemon (`tailscale whois`) at pagtutugma nito sa header bago ito tanggapin.
Tinuturing lang ng OpenClaw na Serve ang isang request kapag dumarating ito mula sa loopback na may
mga header ng Tailscale na `x-forwarded-for`, `x-forwarded-proto`, at `x-forwarded-host`.
Para mangailangan ng tahasang credentials, itakda ang `gateway.auth.allowTailscale: false` o
i-force ang `gateway.auth.mode: "password"`.

## Mga halimbawa ng config

### Tailnet-only (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Buksan: `https://<magicdns>/` (o ang naka-configure mong `gateway.controlUi.basePath`)

### Tailnet-only (i-bind sa Tailnet IP)

Gamitin ito kapag gusto mong direktang makinig ang Gateway sa Tailnet IP (walang Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Kumonek mula sa isa pang Tailnet device:

- Control UI: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Tandaan: ang loopback (`http://127.0.0.1:18789`) ay **hindi** gagana sa mode na ito.

### Pampublikong internet (Funnel + shared password)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Mas mainam ang `OPENCLAW_GATEWAY_PASSWORD` kaysa mag-commit ng password sa disk.

## Mga halimbawa ng CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Mga tala

- Nangangailangan ang Tailscale Serve/Funnel na naka-install at naka-login ang `tailscale` CLI.
- Tumatangging mag-start ang `tailscale.mode: "funnel"` maliban kung ang auth mode ay `password` upang maiwasan ang pampublikong exposure.
- Itakda ang `gateway.tailscale.resetOnExit` kung gusto mong i-undo ng OpenClaw ang `tailscale serve`
  o `tailscale funnel` na configuration sa shutdown.
- Ang `gateway.bind: "tailnet"` ay direktang Tailnet bind (walang HTTPS, walang Serve/Funnel).
- Mas pinipili ng `gateway.bind: "auto"` ang loopback; gamitin ang `tailnet` kung gusto mo ng tailnet-only.
- Inilalantad lang ng Serve/Funnel ang **Gateway control UI + WS**. Kumokonek ang mga node sa
  parehong Gateway WS endpoint, kaya puwedeng gumana ang Serve para sa node access.

## Kontrol sa browser (remote Gateway + lokal na browser)

Kung pinapatakbo mo ang Gateway sa isang machine pero gusto mong kontrolin ang browser sa ibang machine,
magpatakbo ng **node host** sa machine ng browser at panatilihing nasa parehong tailnet ang dalawa.
Ipo-proxy ng Gateway ang mga aksyon ng browser papunta sa node; hindi kailangan ng hiwalay na control server o Serve URL.

Iwasan ang Funnel para sa browser control; ituring ang node pairing na parang operator access.

## Mga paunang kinakailangan + limitasyon ng Tailscale

- Nangangailangan ang Serve ng naka-enable na HTTPS para sa iyong tailnet; magpa-prompt ang CLI kung wala ito.
- Nag-i-inject ang Serve ng mga Tailscale identity header; hindi ito ginagawa ng Funnel.
- Nangangailangan ang Funnel ng Tailscale v1.38.3+, MagicDNS, naka-enable na HTTPS, at funnel node attribute.
- Sinusuportahan lang ng Funnel ang mga port na `443`, `8443`, at `10000` sa ibabaw ng TLS.
- Ang Funnel sa macOS ay nangangailangan ng open-source na variant ng Tailscale app.

## Alamin pa

- Pangkalahatang-ideya ng Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` command: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Pangkalahatang-ideya ng Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` command: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
