---
summary: "Paggamit ng Exec tool, mga mode ng stdin, at suporta sa TTY"
read_when:
  - Kapag gumagamit o nagmo-modify ng exec tool
  - Kapag nagde-debug ng stdin o TTY behavior
title: "Exec Tool"
x-i18n:
  source_path: tools/exec.md
  source_hash: 3b32238dd8dce93d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:07Z
---

# Exec tool

Magpatakbo ng mga shell command sa workspace. Sinusuportahan ang foreground + background execution via `process`.
Kung hindi pinapayagan ang `process`, tumatakbo nang synchronous ang `exec` at binabalewala ang `yieldMs`/`background`.
Ang mga background session ay saklaw kada agent; `process` ay nakakakita lamang ng mga session mula sa parehong agent.

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
- Mahalaga: ang sandboxing ay **naka-off bilang default**. Kapag naka-off ang sandboxing, direktang tumatakbo ang `host=sandbox` sa
  gateway host (walang container) at **hindi nangangailangan ng approvals**. Para mangailangan ng approvals, patakbuhin gamit ang
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

- `host=gateway`: pinagsasama ang iyong login-shell `PATH` sa exec environment. Ang mga override ng `env.PATH` ay
  tinatanggihan para sa host execution. Ang daemon mismo ay patuloy na tumatakbo gamit ang isang minimal na `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: pinapatakbo ang `sh -lc` (login shell) sa loob ng container, kaya maaaring i-reset ng `/etc/profile` ang `PATH`.
  Ini-prepend ng OpenClaw ang `env.PATH` pagkatapos ng profile sourcing via isang internal env var (walang shell interpolation);
  naaangkop din dito ang `tools.exec.pathPrepend`.
- `host=node`: tanging ang mga non-blocked env override na ipinapasa mo ang ipinapadala sa node. Ang mga override ng `env.PATH` ay
  tinatanggihan para sa host execution. Tinatanggap ng mga headless node host ang `PATH` lamang kapag ini-prepend nito ang node host
  PATH (walang replacement). Tinatanggal ng mga macOS node ang mga override ng `PATH` nang buo.

Per-agent node binding (gamitin ang agent list index sa config):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Control UI: ang Nodes tab ay may kasamang maliit na “Exec node binding” panel para sa parehong mga setting.

## Session overrides (`/exec`)

Gamitin ang `/exec` para magtakda ng **per-session** defaults para sa `host`, `security`, `ask`, at `node`.
Ipadala ang `/exec` nang walang mga argument para ipakita ang kasalukuyang mga value.

Halimbawa:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Authorization model

Ang `/exec` ay iginagalang lamang para sa **mga awtorisadong sender** (channel allowlists/pairing kasama ang `commands.useAccessGroups`).
Ina-update nito ang **session state lamang** at hindi nagsusulat ng config. Para ganap na i-disable ang exec, tanggihan ito via tool
policy (`tools.deny: ["exec"]` o per-agent). Nalalapat pa rin ang host approvals maliban kung tahasan mong itakda ang
`security=full` at `ask=off`.

## Exec approvals (companion app / node host)

Maaaring mangailangan ang mga sandboxed agent ng per-request approval bago tumakbo ang `exec` sa gateway o node host.
Tingnan ang [Exec approvals](/tools/exec-approvals) para sa policy, allowlist, at UI flow.

Kapag kinakailangan ang approvals, agad na nagbabalik ang exec tool na may
`status: "approval-pending"` at isang approval id. Kapag naaprubahan (o tinanggihan / nag-time out),
nag-e-emit ang Gateway ng mga system event (`Exec finished` / `Exec denied`). Kung ang command ay patuloy na
tumatakbo pagkatapos ng `tools.exec.approvalRunningNoticeMs`, isang beses na `Exec running` notice ang ilalabas.

## Allowlist + safe bins

Ang enforcement ng allowlist ay tumutugma lamang sa **resolved binary paths** (walang basename matches). Kapag
`security=allowlist`, ang mga shell command ay awtomatikong pinapayagan lamang kung bawat segment ng pipeline ay
allowlisted o isang safe bin. Ang chaining (`;`, `&&`, `||`) at mga redirection ay tinatanggihan sa
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

Ang `apply_patch` ay isang subtool ng `exec` para sa structured multi-file edits.
I-enable ito nang tahasan:

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
