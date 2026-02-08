---
summary: "Integrasyon ng PeekabooBridge para sa macOS UI automation"
read_when:
  - Pagho-host ng PeekabooBridge sa OpenClaw.app
  - Pag-iintegrate ng Peekaboo sa pamamagitan ng Swift Package Manager
  - Pagbabago ng protocol/mga path ng PeekabooBridge
title: "Peekaboo Bridge"
x-i18n:
  source_path: platforms/mac/peekaboo.md
  source_hash: b5b9ddb9a7c59e15
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:42Z
---

# Peekaboo Bridge (macOS UI automation)

Maaaring i-host ng OpenClaw ang **PeekabooBridge** bilang isang lokal, permission‑aware na broker para sa UI automation. Pinapahintulutan nito ang `peekaboo` CLI na magpatakbo ng UI automation habang nire-reuse ang mga TCC permission ng macOS app.

## Ano ito (at ano ang hindi)

- **Host**: Maaaring kumilos ang OpenClaw.app bilang host ng PeekabooBridge.
- **Client**: gamitin ang `peekaboo` CLI (walang hiwalay na `openclaw ui ...` surface).
- **UI**: nananatili ang mga visual overlay sa Peekaboo.app; ang OpenClaw ay isang manipis na broker host.

## I-enable ang bridge

Sa macOS app:

- Settings → **Enable Peekaboo Bridge**

Kapag naka-enable, magsisimula ang OpenClaw ng isang lokal na UNIX socket server. Kapag naka-disable, ititigil ang host at babalik ang `peekaboo` sa iba pang available na host.

## Order ng discovery ng client

Karaniwang sinusubukan ng mga Peekaboo client ang mga host sa ganitong pagkakasunod:

1. Peekaboo.app (buong UX)
2. Claude.app (kung naka-install)
3. OpenClaw.app (manipis na broker)

Gamitin ang `peekaboo bridge status --verbose` para makita kung aling host ang aktibo at kung aling socket path ang ginagamit. Maaari mong i-override gamit ang:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Seguridad at mga permission

- Vine-validate ng bridge ang **caller code signatures**; ipinapatupad ang isang allowlist ng mga TeamID (TeamID ng Peekaboo host + TeamID ng OpenClaw app).
- Nagti-time out ang mga request pagkalipas ng ~10 segundo.
- Kapag kulang ang mga kinakailangang permission, magbabalik ang bridge ng malinaw na error message sa halip na ilunsad ang System Settings.

## Snapshot behavior (automation)

Ang mga snapshot ay iniimbak sa memory at awtomatikong nag-e-expire pagkatapos ng maikling panahon. Kung kailangan mo ng mas mahabang retention, muling kumuha mula sa client.

## Pag-troubleshoot

- Kung mag-report ang `peekaboo` ng “bridge client is not authorized”, tiyaking maayos ang pagkaka-sign ng client o patakbuhin ang host gamit ang `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` sa **debug** mode lamang.
- Kung walang makitang mga host, buksan ang isa sa mga host app (Peekaboo.app o OpenClaw.app) at kumpirmahing naibigay ang mga permission.
