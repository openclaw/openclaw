---
summary: "Integrated na Tailscale Serve/Funnel para sa Gateway dashboard"
read_when:
  - Paglalantad ng Gateway Control UI sa labas ng localhost
  - Pag-automate ng tailnet o pampublikong access sa dashboard
title: "Tailscale"
---

# Tailscale (Gateway dashboard)

39. Maaaring awtomatikong i-configure ng OpenClaw ang Tailscale **Serve** (tailnet) o **Funnel** (public) para sa
    Gateway dashboard at WebSocket port. 40. Pinananatili nitong naka-bind ang Gateway sa loopback habang
    ang Tailscale ang nagbibigay ng HTTPS, routing, at (para sa Serve) identity headers.

## Mga mode

- 41. `serve`: Tailnet-only Serve sa pamamagitan ng `tailscale serve`. 42. Ang gateway ay nananatili sa `127.0.0.1`.
- 43. `funnel`: Pampublikong HTTPS sa pamamagitan ng `tailscale funnel`. 44. Nangangailangan ang OpenClaw ng isang shared password.
- `off`: Default (walang Tailscale automation).

## Auth

Itakda ang `gateway.auth.mode` para kontrolin ang handshake:

- `token` (default kapag naka-set ang `OPENCLAW_GATEWAY_TOKEN`)
- `password` (shared secret sa pamamagitan ng `OPENCLAW_GATEWAY_PASSWORD` o config)

45. Kapag ang `tailscale.mode = "serve"` at ang `gateway.auth.allowTailscale` ay `true`,
    ang mga valid na Serve proxy request ay maaaring mag-authenticate sa pamamagitan ng Tailscale identity headers
    (`tailscale-user-login`) nang hindi nagbibigay ng token/password. 46. Bine-verify ng OpenClaw
    ang identidad sa pamamagitan ng pag-resolve ng `x-forwarded-for` address sa lokal na Tailscale
    daemon (`tailscale whois`) at pagtutugma nito sa header bago ito tanggapin.
46. Itinuturing lamang ng OpenClaw ang isang request bilang Serve kapag ito ay dumarating mula sa loopback na may
    mga header ng Tailscale na `x-forwarded-for`, `x-forwarded-proto`, at `x-forwarded-host`.
47. Upang mangailangan ng hayagang mga kredensyal, itakda ang `gateway.auth.allowTailscale: false` o
    ipilit ang `gateway.auth.mode: "password"`.

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
- 49. Ang Serve/Funnel ay naglalantad lamang ng **Gateway control UI + WS**. 50. Kumokonekta ang mga node sa pamamagitan ng
      parehong Gateway WS endpoint, kaya maaaring gumana ang Serve para sa node access.

## Kontrol sa browser (remote Gateway + lokal na browser)

Kung pinapatakbo mo ang Gateway sa isang makina ngunit gusto mong magpatakbo ng browser sa ibang makina,
magpatakbo ng **node host** sa makina ng browser at panatilihing pareho silang nasa iisang tailnet.
Ipa-proxy ng Gateway ang mga aksyon ng browser papunta sa node; walang hiwalay na control server o Serve URL na kailangan.

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
