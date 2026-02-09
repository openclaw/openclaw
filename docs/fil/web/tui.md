---
summary: "Terminal UI (TUI): kumonekta sa Gateway mula sa anumang machine"
read_when:
  - Gusto mo ng beginner-friendly na walkthrough ng TUI
  - Kailangan mo ang kumpletong listahan ng mga tampok, command, at shortcut ng TUI
title: "TUI"
---

# TUI (Terminal UI)

## Mabilis na pagsisimula

1. Simulan ang Gateway.

```bash
openclaw gateway
```

2. Buksan ang TUI.

```bash
openclaw tui
```

3. Mag-type ng mensahe at pindutin ang Enter.

Remote Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Gamitin ang `--password` kung gumagamit ng password auth ang iyong Gateway.

## Ano ang makikita mo

- Header: URL ng koneksyon, kasalukuyang agent, kasalukuyang session.
- Chat log: mga mensahe ng user, mga sagot ng assistant, mga system notice, mga tool card.
- Status line: estado ng koneksyon/run (connecting, running, streaming, idle, error).
- Footer: estado ng koneksyon + agent + session + model + think/verbose/reasoning + bilang ng token + deliver.
- Input: text editor na may autocomplete.

## Mental model: agents + sessions

- Ang mga agent ay mga natatanging slug (hal. `main`, `research`). Inilalantad ng Gateway ang listahan.
- Ang mga session ay kabilang sa kasalukuyang agent.
- Ang mga session key ay iniimbak bilang `agent:<agentId>:<sessionKey>`.
  - Kapag nag-type ka ng `/session main`, ine-expand ito ng TUI sa `agent:<currentAgent>:main`.
  - Kapag nag-type ka ng `/session agent:other:main`, lilipat ka nang tahasan sa session ng agent na iyon.
- Saklaw ng session:
  - `per-sender` (default): bawat agent ay may maraming session.
  - `global`: palaging ginagamit ng TUI ang `global` na session (maaaring walang laman ang picker).
- Ang kasalukuyang agent + session ay laging makikita sa footer.

## Pagpapadala + delivery

- Ang mga mensahe ay ipinapadala sa Gateway; naka-off bilang default ang delivery sa mga provider.
- I-on ang delivery:
  - `/deliver on`
  - o ang Settings panel
  - o magsimula gamit ang `openclaw tui --deliver`

## Mga picker + overlay

- Model picker: ilista ang mga available na model at itakda ang session override.
- Agent picker: pumili ng ibang agent.
- Session picker: ipinapakita lamang ang mga session para sa kasalukuyang agent.
- Settings: i-toggle ang deliver, pagpapalawak ng tool output, at visibility ng thinking.

## Mga keyboard shortcut

- Enter: magpadala ng mensahe
- Esc: ihinto ang aktibong run
- Ctrl+C: i-clear ang input (pindutin nang dalawang beses para lumabas)
- Ctrl+D: lumabas
- Ctrl+L: model picker
- Ctrl+G: agent picker
- Ctrl+P: session picker
- Ctrl+O: i-toggle ang pagpapalawak ng tool output
- Ctrl+T: i-toggle ang visibility ng thinking (nirere-load ang history)

## Mga slash command

Core:

- `/help`
- `/status`
- `/agent <id>` (o `/agents`)
- `/session <key>` (o `/sessions`)
- `/model <provider/model>` (o `/models`)

Mga kontrol ng session:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Lifecycle ng session:

- `/new` o `/reset` (i-reset ang session)
- `/abort` (ihinto ang aktibong run)
- `/settings`
- `/exit`

Ang iba pang Gateway slash command (halimbawa, `/context`) ay ipinapasa sa Gateway at ipinapakita bilang system output. Tingnan ang [Slash commands](/tools/slash-commands).

## Mga local shell command

- I-prefix ang isang linya ng `!` para magpatakbo ng local shell command sa host ng TUI.
- Magpo-prompt ang TUI isang beses bawat session para pahintulutan ang local execution; kapag tinanggihan, mananatiling disabled ang `!` para sa session.
- Tumatakbo ang mga command sa isang fresh, non-interactive shell sa working directory ng TUI (walang persistent `cd`/env).
- Ang nag-iisang `!` ay ipinapadala bilang normal na mensahe; hindi nagti-trigger ng local exec ang mga leading space.

## Tool output

- Ipinapakita ang mga tool call bilang mga card na may args + resulta.
- Ini-toggle ng Ctrl+O ang collapsed/expanded na view.
- Habang tumatakbo ang mga tool, ang mga partial update ay nag-i-stream sa parehong card.

## History + streaming

- Sa pag-connect, nilo-load ng TUI ang pinakabagong history (default na 200 mensahe).
- Ang mga streaming response ay nag-a-update in place hanggang ma-finalize.
- Nakikinig din ang TUI sa mga event ng agent tool para sa mas mayamang tool card.

## Mga detalye ng koneksyon

- Nagre-register ang TUI sa Gateway bilang `mode: "tui"`.
- Ang mga reconnect ay nagpapakita ng system message; ang mga gap ng event ay inilalantad sa log.

## Mga opsyon

- `--url <url>`: Gateway WebSocket URL (default sa config o `ws://127.0.0.1:<port>`)
- `--token <token>`: Gateway token (kung kinakailangan)
- `--password <password>`: Gateway password (kung kinakailangan)
- `--session <key>`: Session key (default: `main`, o `global` kapag global ang scope)
- `--deliver`: I-deliver ang mga sagot ng assistant sa provider (default naka-off)
- `--thinking <level>`: I-override ang thinking level para sa mga pagpapadala
- `--timeout-ms <ms>`: Agent timeout sa ms (default sa `agents.defaults.timeoutSeconds`)

Note: when you set `--url`, the TUI does not fall back to config or environment credentials.
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

## Pag-troubleshoot

Walang output matapos magpadala ng mensahe:

- Patakbuhin ang `/status` sa TUI para kumpirmahin na nakakonekta ang Gateway at idle/busy.
- Suriin ang mga log ng Gateway: `openclaw logs --follow`.
- Kumpirmahin na puwedeng tumakbo ang agent: `openclaw status` at `openclaw models status`.
- Kung inaasahan mo ang mga mensahe sa isang chat channel, i-enable ang delivery (`/deliver on` o `--deliver`).
- `--history-limit <n>`: Mga history entry na ilo-load (default 200)

## Pag-troubleshoot ng koneksyon

- `disconnected`: tiyaking tumatakbo ang Gateway at tama ang iyong `--url/--token/--password`.
- Walang agent sa picker: suriin ang `openclaw agents list` at ang iyong routing config.
- Walang laman ang session picker: maaaring nasa global scope ka o wala ka pang mga session.
