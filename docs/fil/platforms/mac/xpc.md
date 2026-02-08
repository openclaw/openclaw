---
summary: "Arkitektura ng macOS IPC para sa OpenClaw app, transport ng Gateway node, at PeekabooBridge"
read_when:
  - Pag-edit ng mga kontrata ng IPC o IPC ng menu bar app
title: "macOS IPC"
x-i18n:
  source_path: platforms/mac/xpc.md
  source_hash: d0211c334a4a59b7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:45Z
---

# Arkitektura ng OpenClaw macOS IPC

**Kasalukuyang modelo:** isang lokal na Unix socket ang nag-uugnay sa **node host service** at sa **macOS app** para sa mga pag-apruba ng exec + `system.run`. May umiiral na `openclaw-mac` debug CLI para sa discovery/connect checks; ang mga aksyon ng agent ay dumadaloy pa rin sa Gateway WebSocket at `node.invoke`. Gumagamit ang UI automation ng PeekabooBridge.

## Mga layunin

- Isang iisang GUI app instance na may-ari ng lahat ng TCC-facing na gawain (notifications, screen recording, mic, speech, AppleScript).
- Maliit na surface para sa automation: Gateway + mga command ng node, at PeekabooBridge para sa UI automation.
- Prediktableng mga pahintulot: palaging pareho ang signed bundle ID, inilulunsad ng launchd, kaya nananatili ang mga TCC grant.

## Paano ito gumagana

### Gateway + node transport

- Pinapatakbo ng app ang Gateway (local mode) at kumokonekta rito bilang isang node.
- Isinasagawa ang mga aksyon ng agent sa pamamagitan ng `node.invoke` (hal. `system.run`, `system.notify`, `canvas.*`).

### Node service + app IPC

- Isang headless na node host service ang kumokonekta sa Gateway WebSocket.
- Ang mga kahilingang `system.run` ay ipinapasa sa macOS app sa pamamagitan ng lokal na Unix socket.
- Isinasagawa ng app ang exec sa UI context, magpo-prompt kung kinakailangan, at ibinabalik ang output.

Diagram (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (UI automation)

- Gumagamit ang UI automation ng hiwalay na UNIX socket na pinangalanang `bridge.sock` at ng PeekabooBridge JSON protocol.
- Host preference order (client-side): Peekaboo.app → Claude.app → OpenClaw.app → lokal na execution.
- Seguridad: ang mga bridge host ay nangangailangan ng pinapayagang TeamID; ang DEBUG-only same-UID escape hatch ay binabantayan ng `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (konbensyon ng Peekaboo).
- Tingnan: [Paggamit ng PeekabooBridge](/platforms/mac/peekaboo) para sa mga detalye.

## Mga operational flow

- Restart/rebuild: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Pinapatay ang mga umiiral na instance
  - Swift build + package
  - Nagsusulat/nagbo-bootstrap/nagki-kickstart ng LaunchAgent
- Isang instance lang: maagang nag-e-exit ang app kung may tumatakbong ibang instance na may parehong bundle ID.

## Mga tala sa hardening

- Mas mainam na hingin ang pagtutugma ng TeamID para sa lahat ng privileged surface.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) ay maaaring pahintulutan ang same-UID callers para sa lokal na development.
- Lahat ng komunikasyon ay nananatiling lokal lamang; walang network socket na inilalantad.
- Ang mga TCC prompt ay nagmumula lamang sa GUI app bundle; panatilihing stable ang signed bundle ID sa mga rebuild.
- IPC hardening: socket mode `0600`, token, peer-UID checks, HMAC challenge/response, maikling TTL.
