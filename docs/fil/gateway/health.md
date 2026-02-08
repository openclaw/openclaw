---
summary: "Mga hakbang sa health check para sa connectivity ng channel"
read_when:
  - Pag-diagnose ng kalusugan ng WhatsApp channel
title: "Mga Health Check"
x-i18n:
  source_path: gateway/health.md
  source_hash: 74f242e98244c135
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:29Z
---

# Mga Health Check (CLI)

Maikling gabay para i-verify ang connectivity ng channel nang hindi nanghuhula.

## Mga mabilisang check

- `openclaw status` — lokal na buod: abot/kundisyon ng Gateway, hint sa update, edad ng auth ng naka-link na channel, mga session + kamakailang aktibidad.
- `openclaw status --all` — kumpletong lokal na diagnosis (read-only, may kulay, ligtas i-paste para sa debugging).
- `openclaw status --deep` — sinusuri rin ang tumatakbong Gateway (per-channel probes kapag suportado).
- `openclaw health --json` — humihingi sa tumatakbong Gateway ng buong health snapshot (WS-only; walang direktang Baileys socket).
- Ipadala ang `/status` bilang standalone na mensahe sa WhatsApp/WebChat para makakuha ng status reply nang hindi tinatawag ang agent.
- Mga log: i-tail ang `/tmp/openclaw/openclaw-*.log` at i-filter para sa `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Mas malalim na diagnostics

- Mga kredensyal sa disk: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (dapat kamakailan ang mtime).
- Session store: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (maaaring i-override ang path sa config). Ang bilang at mga kamakailang recipient ay ipinapakita sa pamamagitan ng `status`.
- Relink flow: `openclaw channels logout && openclaw channels login --verbose` kapag lumitaw ang mga status code na 409–515 o `loggedOut` sa mga log. (Tandaan: ang QR login flow ay awtomatikong magre-restart nang isang beses para sa status 515 pagkatapos ng pairing.)

## Kapag may pumalya

- `logged out` o status 409–515 → mag-relink gamit ang `openclaw channels logout` pagkatapos ay `openclaw channels login`.
- Hindi maabot ang Gateway → simulan ito: `openclaw gateway --port 18789` (gamitin ang `--force` kung abala ang port).
- Walang papasok na mensahe → kumpirmahing online ang naka-link na telepono at pinapayagan ang sender (`channels.whatsapp.allowFrom`); para sa mga group chat, tiyaking tugma ang mga panuntunan ng allowlist + mention (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Dedikadong "health" command

Humihingi ang `openclaw health --json` sa tumatakbong Gateway ng health snapshot nito (walang direktang channel sockets mula sa CLI). Iuulat nito ang naka-link na creds/edad ng auth kapag available, mga buod ng probe kada channel, buod ng session-store, at tagal ng probe. Lalabas ito na non-zero kapag hindi maabot ang Gateway o pumalya/nag-timeout ang probe. Gamitin ang `--timeout <ms>` para i-override ang default na 10s.
