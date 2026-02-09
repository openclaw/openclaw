---
summary: "Direktang pagpapatakbo ng `openclaw agent` CLI (may opsyonal na delivery)"
read_when:
  - Pagdaragdag o pagbabago ng agent CLI entrypoint
title: "Agent Send"
---

# `openclaw agent` (direktang pagpapatakbo ng agent)

13. Ang `openclaw agent` ay nagpapatakbo ng isang solong agent turn nang hindi nangangailangan ng papasok na chat message.
14. Bilang default, dumadaan ito **sa Gateway**; idagdag ang `--local` para pilitin ang embedded runtime sa kasalukuyang makina.

## Behavior

- Kinakailangan: `--message <text>`
- Pagpili ng session:
  - Kinukuha ng `--to <dest>` ang session key (ang mga target na group/channel ay pinananatili ang isolation; ang mga direct chat ay nagsasama sa `main`), **o**
  - Ginagamit muli ng `--session-id <id>` ang isang umiiral na session ayon sa id, **o**
  - Tina-target ng `--agent <id>` ang isang naka-configure na agent nang direkta (ginagamit ang session key ng agent na iyon na `main`)
- Pinapatakbo ang parehong embedded agent runtime gaya ng mga normal na inbound reply.
- Ang mga thinking/verbose flag ay nananatili sa session store.
- Output:
  - default: ipiniprint ang reply text (kasama ang mga linya ng `MEDIA:<url>`)
  - `--json`: ipiniprint ang structured payload + metadata
- Opsyonal na delivery pabalik sa isang channel gamit ang `--deliver` + `--channel` (ang mga format ng target ay tumutugma sa `openclaw message --target`).
- Gamitin ang `--reply-channel`/`--reply-to`/`--reply-account` para i-override ang delivery nang hindi binabago ang session.

Kung hindi maabot ang Gateway, ang CLI ay **awtomatikong babagsak** sa embedded local run.

## Mga halimbawa

```bash
openclaw agent --to +15555550123 --message "status update"
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --to +15555550123 --message "Summon reply" --deliver
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## Mga flag

- `--local`: tumakbo nang lokal (nangangailangan ng mga API key ng model provider sa iyong shell)
- `--deliver`: ipadala ang reply sa napiling channel
- `--channel`: delivery channel (`whatsapp|telegram|discord|googlechat|slack|signal|imessage`, default: `whatsapp`)
- `--reply-to`: override ng delivery target
- `--reply-channel`: override ng delivery channel
- `--reply-account`: override ng delivery account id
- `--thinking <off|minimal|low|medium|high|xhigh>`: i-persist ang antas ng thinking (mga model na GPT-5.2 + Codex lamang)
- `--verbose <on|full|off>`: i-persist ang antas ng verbose
- `--timeout <seconds>`: override ng agent timeout
- `--json`: maglabas ng structured JSON
