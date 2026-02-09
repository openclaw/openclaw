---
summary: "Paggamit ng Exec tool, mga mode ng stdin, at suporta sa TTY"
read_when:
  - Kapag gumagamit o nagmo-modify ng exec tool
  - Kapag nagde-debug ng stdin o TTY behavior
title: "Exec Tool"
---

# Exec tool

Magpatakbo ng mga shell command sa workspace. Sinusuportahan ang foreground + background execution sa pamamagitan ng `process`.
Kapag hindi pinapayagan ang `process`, tumatakbo nang synchronous ang `exec` at binabalewala ang `yieldMs`/`background`.
Ang mga background session ay naka-scope per agent; ang `process` ay nakakakita lamang ng mga session mula sa parehong agent.

## Parameters

- `command` (kinakailangan)
- `workdir` (default sa cwd)
- `env` (key/value overrides)
- `yieldMs` (default 10000): awtomatikong mag-background pagkatapos ng delay
- `background` (bool): agad na i-background
- `timeout` (seconds, default 1800): patayin kapag nag-expire
- `pty` (bool): patakbuhin sa isang pseudo-terminal kapag available (TTY-only CLIs, coding agents, terminal UIs)
- `host` (`sandbox | gateway | node`): kung saan ipapatupad
- `security` (`deny | allowlist | full`): enforcement mode para sa `gateway`/`node`
- `ask` (`off | on-miss | always`): mga approval prompt para sa `gateway`/`node`
- `node` (string): node id/name para sa `host=node`
- `elevated` (bool): humiling ng elevated mode (gateway host); ang `security=full` ay pinipilit lamang kapag ang elevated ay nagre-resolve sa `full`

Mga tala:

- Ang `host` ay default sa `sandbox`.
- Binabalewala ang `elevated` kapag naka-off ang sandboxing (direktang tumatakbo ang exec sa host).
- Ang mga approval ng `gateway`/`node` ay kinokontrol ng `~/.openclaw/exec-approvals.json`.
- Nangangailangan ang `node` ng naka-pair na node (companion app o headless node host).
- Kung maraming node ang available, itakda ang `exec.node` o `tools.exec.node` para pumili ng isa.
- Sa mga non-Windows host, ginagamit ng exec ang `SHELL` kapag nakatakda; kung ang `SHELL` ay `fish`, mas pinipili nito ang `bash` (o `sh`)
  mula sa `PATH` para maiwasan ang fish-incompatible scripts, pagkatapos ay babagsak sa `SHELL` kung wala ang alinman.
- Ang host execution (`gateway`/`node`) ay tinatanggihan ang `env.PATH` at mga loader override (`LD_*`/`DYLD_*`) upang
  maiwasan ang binary hijacking o injected code.
- Mahalaga: ang sandboxing ay **naka-off bilang default**. Kung naka-off ang sandboxing, ang `host=sandbox` ay tumatakbo nang direkta sa
  gateway host (walang container) at **hindi nangangailangan ng approvals**. 8. Para mangailangan ng approvals, patakbuhin gamit ang
  `host=gateway` at i-configure ang exec approvals (o i-enable ang sandboxing).

## Config

- `tools.exec.notifyOnExit` (default: true): kapag true, ang mga backgrounded exec session ay nag-e-enqueue ng system event at humihiling ng heartbeat sa pag-exit.
- `tools.exec.approvalRunningNoticeMs` (default: 10000): maglabas ng isang “running” notice kapag ang approval-gated exec ay tumatakbo nang mas mahaba rito (0 para i-disable).
- `tools.exec.host` (default: `sandbox`)
- `tools.exec.security` (default: `deny` para sa sandbox, `allowlist` para sa gateway + node kapag unset)
- `tools.exec.ask` (default: `on-miss`)
- `tools.exec.node` (default: unset)
- `tools.exec.pathPrepend`: listahan ng mga directory na ipi-prepend sa `PATH` para sa mga exec run.
- `tools.exec.safeBins`: mga stdin-only na ligtas na binary na maaaring tumakbo nang walang tahasang allowlist entry.

Halimbawa:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH handling

- `host=gateway`: isinasama ang iyong login-shell `PATH` sa exec environment. Ang mga override ng `env.PATH` ay
  tinatanggihan para sa host execution. 9. Ang daemon mismo ay tumatakbo pa rin gamit ang isang minimal na `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: nagpapatakbo ng `sh -lc` (login shell) sa loob ng container, kaya maaaring i-reset ng `/etc/profile` ang `PATH`.
  Idinadagdag ng OpenClaw ang `env.PATH` pagkatapos ma-source ang profile sa pamamagitan ng isang internal env var (walang shell interpolation);
  nalalapat din dito ang `tools.exec.pathPrepend`.
- 10. `host=node`: ang mga env override na ipinasa mo lang na hindi naka-block ang ipinapadala sa node. 11. Ang mga override ng `env.PATH` ay
      tinatanggihan para sa host execution. 12. Tumatanggap ang mga headless node host ng `PATH` lamang kapag ito ay nagpi-prepend sa node host
      PATH (walang kapalit). Ganap na inaalis ng mga macOS node ang mga override ng `PATH`.

Per-agent node binding (gamitin ang agent list index sa config):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Control UI: ang Nodes tab ay may kasamang maliit na “Exec node binding” panel para sa parehong mga setting.

## Session overrides (`/exec`)

Gamitin ang `/exec` para magtakda ng mga **per-session** na default para sa `host`, `security`, `ask`, at `node`.
Ipadala ang `/exec` nang walang argumento para ipakita ang kasalukuyang mga halaga.

Halimbawa:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Authorization model

13. Ang `/exec` ay iginagalang lamang para sa **mga awtorisadong sender** (mga channel allowlist/pairing kasama ang `commands.useAccessGroups`).
14. Ina-update nito ang **session state lamang** at hindi nagsusulat ng config. Para tuluyang i-disable ang exec, tanggihan ito sa pamamagitan ng tool
    policy (`tools.deny: ["exec"]` o per-agent). Nalalapat pa rin ang host approvals maliban kung tahasan mong itakda ang
    `security=full` at `ask=off`.

## Exec approvals (companion app / node host)

15. Ang mga sandboxed agent ay maaaring mangailangan ng per-request na approval bago tumakbo ang `exec` sa gateway o node host.
16. Tingnan ang [Exec approvals](/tools/exec-approvals) para sa policy, allowlist, at UI flow.

17. Kapag kinakailangan ang approvals, ang exec tool ay agad na nagbabalik na may
    `status: "approval-pending"` at isang approval id. Kapag naaprubahan (o tinanggihan / nag-time out),
    naglalabas ang Gateway ng mga system event (`Exec finished` / `Exec denied`). 18. Kung ang command ay patuloy pa ring
    tumatakbo pagkatapos ng `tools.exec.approvalRunningNoticeMs`, isang beses na `Exec running` notice ang inilalabas.

## Allowlist + safe bins

Ang pagpapatupad ng allowlist ay tumutugma lamang sa mga **resolved binary path** (walang basename match). Kapag
`security=allowlist`, ang mga shell command ay awtomatikong pinapayagan lamang kung ang bawat segment ng pipeline ay
nasa allowlist o isang ligtas na bin. Ang chaining (`;`, `&&`, `||`) at mga redirection ay tinatanggihan sa
allowlist mode.

## Mga halimbawa

Foreground:

```json
{ "tool": "exec", "command": "ls -la" }
```

Background + poll:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Magpadala ng mga key (tmux-style):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Submit (magpadala ng CR lang):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste (naka-bracket bilang default):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (experimental)

19. Ang `apply_patch` ay isang subtool ng `exec` para sa structured na multi-file edits.
    Enable it explicitly:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Mga tala:

- Available lamang para sa mga modelong OpenAI/OpenAI Codex.
- Nalalapat pa rin ang tool policy; implicit na pinapayagan ng `allow: ["exec"]` ang `apply_patch`.
- Ang config ay nasa ilalim ng `tools.exec.applyPatch`.
