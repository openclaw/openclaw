---
summary: "Mga sub-agent: pag-spawn ng mga hiwalay na agent run na nag-aanunsyo ng mga resulta pabalik sa requester chat"
read_when:
  - Gusto mo ng background/parallel na trabaho gamit ang agent
  - Binabago mo ang sessions_spawn o patakaran ng sub-agent tool
title: "Mga Sub-Agent"
x-i18n:
  source_path: tools/subagents.md
  source_hash: 3c83eeed69a65dbb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:07Z
---

# Mga Sub-Agent

Ang mga sub-agent ay mga background agent run na ini-spawn mula sa isang umiiral na agent run. Tumatakbo sila sa sarili nilang session (`agent:<agentId>:subagent:<uuid>`) at, kapag natapos na, **inaanunsyo** nila ang kanilang resulta pabalik sa requester chat channel.

## Slash command

Gamitin ang `/subagents` para siyasatin o kontrolin ang mga sub-agent run para sa **kasalukuyang session**:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

Ipinapakita ng `/subagents info` ang metadata ng run (status, mga timestamp, session id, transcript path, cleanup).

Mga pangunahing layunin:

- I-parallelize ang “research / mahabang gawain / mabagal na tool” na trabaho nang hindi bina-block ang pangunahing run.
- Panatilihing hiwalay ang mga sub-agent bilang default (pagkakahiwalay ng session + opsyonal na sandboxing).
- Panatilihing mahirap abusuhin ang tool surface: ang mga sub-agent ay **hindi** nakakakuha ng session tools bilang default.
- Iwasan ang nested fan-out: ang mga sub-agent ay hindi maaaring mag-spawn ng mga sub-agent.

Tala sa gastos: bawat sub-agent ay may **sarili** nitong context at paggamit ng token. Para sa mabibigat o paulit-ulit na gawain, magtakda ng mas murang model para sa mga sub-agent at panatilihin ang iyong pangunahing agent sa mas mataas ang kalidad na model. Maaari mo itong i-configure sa pamamagitan ng `agents.defaults.subagents.model` o per-agent overrides.

## Tool

Gamitin ang `sessions_spawn`:

- Nagsisimula ng sub-agent run (`deliver: false`, global lane: `subagent`)
- Pagkatapos ay nagpapatakbo ng announce step at ipinopost ang announce reply sa requester chat channel
- Default na model: minamana ang caller maliban kung magtakda ka ng `agents.defaults.subagents.model` (o per-agent `agents.list[].subagents.model`); mananaig pa rin ang isang tahasang `sessions_spawn.model`.
- Default na thinking: minamana ang caller maliban kung magtakda ka ng `agents.defaults.subagents.thinking` (o per-agent `agents.list[].subagents.thinking`); mananaig pa rin ang isang tahasang `sessions_spawn.thinking`.

Mga param ng tool:

- `task` (kinakailangan)
- `label?` (opsyonal)
- `agentId?` (opsyonal; mag-spawn sa ilalim ng ibang agent id kung pinapayagan)
- `model?` (opsyonal; ina-override ang model ng sub-agent; nilalaktawan ang mga invalid na value at tatakbo ang sub-agent sa default na model na may babala sa tool result)
- `thinking?` (opsyonal; ina-override ang antas ng thinking para sa sub-agent run)
- `runTimeoutSeconds?` (default `0`; kapag itinakda, ia-abort ang sub-agent run pagkalipas ng N segundo)
- `cleanup?` (`delete|keep`, default `keep`)

Allowlist:

- `agents.list[].subagents.allowAgents`: listahan ng mga agent id na maaaring i-target sa pamamagitan ng `agentId` (`["*"]` para payagan ang alinman). Default: ang requester agent lamang.

Discovery:

- Gamitin ang `agents_list` para makita kung aling mga agent id ang kasalukuyang pinapayagan para sa `sessions_spawn`.

Auto-archive:

- Ang mga sub-agent session ay awtomatikong ina-archive pagkalipas ng `agents.defaults.subagents.archiveAfterMinutes` (default: 60).
- Gumagamit ang archive ng `sessions.delete` at pinapalitan ang pangalan ng transcript sa `*.deleted.<timestamp>` (parehong folder).
- Ang `cleanup: "delete"` ay nag-a-archive kaagad pagkatapos ng announce (pinananatili pa rin ang transcript sa pamamagitan ng rename).
- Ang auto-archive ay best-effort; nawawala ang mga nakabinbing timer kung mag-restart ang gateway.
- Ang `runTimeoutSeconds` ay **hindi** nag-a-auto-archive; pinipigilan lang nito ang run. Mananatili ang session hanggang sa auto-archive.

## Authentication

Ang auth ng sub-agent ay nireresolba ayon sa **agent id**, hindi ayon sa uri ng session:

- Ang sub-agent session key ay `agent:<agentId>:subagent:<uuid>`.
- Ang auth store ay nilo-load mula sa `agentDir` ng agent na iyon.
- Ang mga auth profile ng pangunahing agent ay mino-merge bilang **fallback**; inuuna ng mga profile ng agent ang mga profile ng main agent kapag may conflict.

Tandaan: additive ang merge, kaya palaging available ang mga profile ng main agent bilang fallback. Hindi pa sinusuportahan ang ganap na hiwalay na auth per agent.

## Announce

Nag-uulat pabalik ang mga sub-agent sa pamamagitan ng isang announce step:

- Tumatakbo ang announce step sa loob ng sub-agent session (hindi sa requester session).
- Kung eksaktong `ANNOUNCE_SKIP` ang sagot ng sub-agent, walang ipo-post.
- Kung hindi, ipo-post ang announce reply sa requester chat channel sa pamamagitan ng isang follow-up na `agent` call (`deliver=true`).
- Pinapanatili ng mga announce reply ang thread/topic routing kapag available (Slack threads, Telegram topics, Matrix threads).
- Ang mga announce message ay ini-normalize sa isang stable na template:
  - `Status:` na hinango mula sa kinalabasan ng run (`success`, `error`, `timeout`, o `unknown`).
  - `Result:` ang nilalaman ng buod mula sa announce step (o `(not available)` kung wala).
  - `Notes:` mga detalye ng error at iba pang kapaki-pakinabang na konteksto.
- Ang `Status` ay hindi hinuhulaan mula sa model output; nagmumula ito sa mga runtime outcome signal.

Kasama sa mga announce payload ang isang stats line sa dulo (kahit naka-wrap):

- Runtime (hal., `runtime 5m12s`)
- Paggamit ng token (input/output/kabuuan)
- Tinatayang gastos kapag naka-configure ang model pricing (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId`, at transcript path (para makuha ng main agent ang history sa pamamagitan ng `sessions_history` o siyasatin ang file sa disk)

## Tool Policy (mga tool ng sub-agent)

Bilang default, nakakakuha ang mga sub-agent ng **lahat ng tool maliban sa session tools**:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

I-override sa pamamagitan ng config:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Concurrency

Gumagamit ang mga sub-agent ng isang dedicated in-process queue lane:

- Pangalan ng lane: `subagent`
- Concurrency: `agents.defaults.subagents.maxConcurrent` (default `8`)

## Stopping

- Ang pagpapadala ng `/stop` sa requester chat ay ina-abort ang requester session at pinipigilan ang anumang aktibong sub-agent run na na-spawn mula rito.

## Mga Limitasyon

- Ang sub-agent announce ay **best-effort**. Kung mag-restart ang gateway, mawawala ang mga nakabinbing “announce back” na gawain.
- Ibinabahagi pa rin ng mga sub-agent ang parehong mga resource ng proseso ng gateway; ituring ang `maxConcurrent` bilang safety valve.
- Ang `sessions_spawn` ay palaging non-blocking: agad itong nagbabalik ng `{ status: "accepted", runId, childSessionKey }`.
- Ang context ng sub-agent ay nag-i-inject lamang ng `AGENTS.md` + `TOOLS.md` (walang `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, o `BOOTSTRAP.md`).
