---
summary: "Pagpapatakbo ng background exec at pamamahala ng proseso"
read_when:
  - Pagdaragdag o pagbabago ng behavior ng background exec
  - Pag-debug ng mga long-running na exec task
title: "Background Exec at Process Tool"
---

# Background Exec + Process Tool

Pinamamahalaan ng `process` tool ang mga background session na iyon. Kailangan ng totoong TTY?

## exec tool

Mga pangunahing parameter:

- `command` (kinakailangan)
- `yieldMs` (default 10000): awtomatikong i-background pagkatapos ng delay na ito
- `background` (bool): i-background kaagad
- `timeout` (segundo, default 1800): patayin ang proseso pagkatapos ng timeout na ito
- `elevated` (bool): patakbuhin sa host kung naka-enable/allowed ang elevated mode
- Itakda ang `pty: true`. Set `pty: true`.
- `workdir`, `env`

Behavior:

- Ang mga foreground run ay direktang nagbabalik ng output.
- Kapag na-background (explicit o dahil sa timeout), ibinabalik ng tool ang `status: "running"` + `sessionId` at isang maikling tail.
- Ang output ay pinananatili sa memory hanggang ma-poll o ma-clear ang session.
- Kung hindi pinapayagan ang `process` tool, tumatakbo ang `exec` nang synchronously at binabalewala ang `yieldMs`/`background`.

## Child process bridging

Kapag naglulunsad ng mga pangmatagalang child process sa labas ng exec/process tools (hal., mga CLI respawn o gateway helper), ikabit ang child‑process bridge helper upang maipasa ang mga termination signal at matanggal ang mga listener sa exit/error. Iniiwasan nito ang mga orphaned process sa systemd at pinananatiling pare‑pareho ang shutdown behavior sa iba’t ibang platform.

Environment overrides:

- `PI_BASH_YIELD_MS`: default yield (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: in‑memory output cap (chars)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: cap ng pending stdout/stderr bawat stream (chars)
- `PI_BASH_JOB_TTL_MS`: TTL para sa mga natapos na session (ms, naka-bound sa 1m–3h)

Config (inirerekomenda):

- `tools.exec.backgroundMs` (default 10000)
- `tools.exec.timeoutSec` (default 1800)
- `tools.exec.cleanupMs` (default 1800000)
- `tools.exec.notifyOnExit` (default true): i-enqueue ang isang system event + mag-request ng heartbeat kapag lumabas ang isang backgrounded exec.

## process tool

Mga aksyon:

- `list`: tumatakbo + natapos na mga session
- `poll`: i-drain ang bagong output para sa isang session (nag-uulat din ng exit status)
- `log`: basahin ang pinagsama-samang output (sumusuporta sa `offset` + `limit`)
- `write`: magpadala ng stdin (`data`, opsyonal na `eof`)
- `kill`: i-terminate ang isang background session
- `clear`: alisin ang isang natapos na session mula sa memory
- `remove`: patayin kung tumatakbo, kung hindi ay i-clear kung tapos na

Mga tala:

- Tanging mga backgrounded na session ang naka-lista/nananatili sa memory.
- Nawawala ang mga session kapag nag-restart ang proseso (walang disk persistence).
- Ang mga log ng session ay nase-save lamang sa chat history kung patatakbuhin mo ang `process poll/log` at maire-record ang resulta ng tool.
- Ang `process` ay scoped bawat agent; nakikita lamang nito ang mga session na sinimulan ng agent na iyon.
- Ang `process list` ay may kasamang derived na `name` (command verb + target) para sa mabilisang pag-scan.
- Ang `process log` ay gumagamit ng line-based na `offset`/`limit` (alisin ang `offset` para kunin ang huling N linya).

## Mga halimbawa

Magpatakbo ng long task at mag-poll sa ibang pagkakataon:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Magsimula kaagad sa background:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Magpadala ng stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
