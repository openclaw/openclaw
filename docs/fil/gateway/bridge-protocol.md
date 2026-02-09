---
summary: "Bridge protocol (legacy nodes): TCP JSONL, pairing, scoped RPC"
read_when:
  - Pagbuo o pag-debug ng mga node client (iOS/Android/macOS node mode)
  - Pagsisiyasat ng mga pagkabigo sa pairing o bridge auth
  - Pag-audit sa node surface na inilalantad ng gateway
title: "Bridge Protocol"
---

# Bridge protocol (legacy node transport)

Ang Bridge protocol ay isang **legacy** na node transport (TCP JSONL). Ang mga bagong node client ay dapat gumamit ng pinag‑isang Gateway WebSocket protocol sa halip.

Kung gumagawa ka ng operator o node client, gamitin ang
[Gateway protocol](/gateway/protocol).

**Tandaan:** Ang kasalukuyang OpenClaw build ay hindi na kasama ang TCP bridge listener; ang dokumentong ito ay pinananatili para sa historikal na sanggunian.
Ang mga legacy na `bridge.*` config key ay hindi na bahagi ng config schema.

## Bakit mayroon tayo ng dalawa

- **Security boundary**: ang bridge ay naglalantad ng maliit na allowlist sa halip na ang
  buong gateway API surface.
- **Pairing + node identity**: ang admission ng node ay pagmamay-ari ng gateway at nakatali
  sa per-node token.
- **Discovery UX**: maaaring mag-discover ang mga node ng mga gateway sa pamamagitan ng Bonjour sa LAN, o direktang kumonekta sa isang tailnet.
- **Loopback WS**: ang buong WS control plane ay nananatiling lokal maliban kung itunel sa pamamagitan ng SSH.

## Transport

- TCP, isang JSON object bawat linya (JSONL).
- Opsyonal na TLS (kapag ang `bridge.tls.enabled` ay true).
- Ang legacy na default listener port ay `18790` (ang mga kasalukuyang build ay hindi nagsisimula ng TCP bridge).

Kapag naka-enable ang TLS, ang discovery TXT records ay kasama ang `bridgeTls=1` kasama ang
`bridgeTlsSha256` upang ma-pin ng mga node ang certificate.

## Handshake + pairing

1. Nagpapadala ang client ng `hello` na may node metadata + token (kung naka-pair na).
2. Kung hindi pa naka-pair, sasagot ang gateway ng `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. Nagpapadala ang client ng `pair-request`.
4. Naghihintay ang gateway ng approval, pagkatapos ay nagpapadala ng `pair-ok` at `hello-ok`.

Ang `hello-ok` ay nagbabalik ng `serverName` at maaaring magsama ng `canvasHostUrl`.

## Frames

Client → Gateway:

- `req` / `res`: scoped gateway RPC (chat, sessions, config, health, voicewake, skills.bins)
- `event`: mga signal ng node (voice transcript, agent request, chat subscribe, exec lifecycle)

Gateway → Client:

- `invoke` / `invoke-res`: mga command ng node (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: mga update ng chat para sa mga naka-subscribe na session
- `ping` / `pong`: keepalive

Ang legacy allowlist enforcement ay nanirahan sa `src/gateway/server-bridge.ts` (inalis na).

## Exec lifecycle events

Maaaring maglabas ang mga node ng mga event na `exec.finished` o `exec.denied` upang ipakita ang system.run activity.
Ang mga ito ay kino‑map sa mga system event sa gateway. (Maaaring maglabas pa rin ang mga legacy node ng `exec.started`.)

Mga field ng payload (lahat ay opsyonal maliban kung nakasaad):

- `sessionKey` (kinakailangan): agent session na tatanggap ng system event.
- `runId`: natatanging exec id para sa pag-group.
- `command`: raw o formatted na command string.
- `exitCode`, `timedOut`, `success`, `output`: mga detalye ng completion (tapos lamang).
- `reason`: dahilan ng denial (denied lamang).

## Tailnet usage

- I-bind ang bridge sa isang tailnet IP: `bridge.bind: "tailnet"` sa
  `~/.openclaw/openclaw.json`.
- Kumokonekta ang mga client sa pamamagitan ng MagicDNS name o tailnet IP.
- Ang Bonjour ay **hindi** tumatawid ng mga network; gumamit ng manual host/port o wide-area DNS‑SD
  kapag kinakailangan.

## Versioning

Ang Bridge ay kasalukuyang **implicit v1** (walang min/max negotiation). Inaasahan ang backward‑compat; magdagdag ng bridge protocol version field bago ang anumang breaking change.
