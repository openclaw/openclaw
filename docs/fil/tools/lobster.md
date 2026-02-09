---
title: Lobster
summary: "Typed na workflow runtime para sa OpenClaw na may resumable approval gates."
description: Typed na workflow runtime para sa OpenClaw — composable na mga pipeline na may approval gates.
read_when:
  - Gusto mo ng deterministic na multi-step workflows na may malinaw na mga approval
  - Kailangan mong i-resume ang isang workflow nang hindi muling pinapatakbo ang mga naunang hakbang
---

# Lobster

Ang Lobster ay isang workflow shell na nagbibigay-daan sa OpenClaw na magpatakbo ng mga multi-step tool sequence bilang isang solong, deterministic na operasyon na may malinaw na mga approval checkpoint.

## Hook

42. Ang iyong assistant ay maaaring bumuo ng mga tool na namamahala sa sarili nito. Ask for a workflow, and 30 minutes later you have a CLI plus pipelines that run as one call. Lobster is the missing piece: deterministic pipelines, explicit approvals, and resumable state.

## Why

43. Sa kasalukuyan, ang mga kumplikadong workflow ay nangangailangan ng maraming pabalik-balik na tool call. 44. Bawat tawag ay may gastos sa token, at kailangang i-orchestrate ng LLM ang bawat hakbang. Lobster moves that orchestration into a typed runtime:

- **Isang tawag imbes na marami**: Nagpapatakbo ang OpenClaw ng isang Lobster tool call at nakakakuha ng structured na resulta.
- **May built-in na approvals**: Ang mga side effect (magpadala ng email, mag-post ng komento) ay humihinto sa workflow hanggang sa malinaw na maaprubahan.
- **Resumable**: Ang mga humintong workflow ay nagbabalik ng token; aprubahan at i-resume nang hindi muling pinapatakbo ang lahat.

## Bakit DSL imbes na plain programs?

Lobster is intentionally small. The goal is not "a new language," it's a predictable, AI-friendly pipeline spec with first-class approvals and resume tokens.

- **Built-in ang approve/resume**: Kayang mag-prompt ng tao ang isang normal na program, pero hindi ito makaka-_pause at resume_ gamit ang isang durable token nang hindi ka gumagawa ng sarili mong runtime.
- **Determinism + auditability**: Data ang mga pipeline, kaya madaling i-log, i-diff, i-replay, at i-review.
- **Constrained surface para sa AI**: Maliit na grammar + JSON piping ang nagbabawas ng mga “creative” code path at ginagawang realistic ang validation.
- **May baked-in na safety policy**: Ang mga timeout, output cap, sandbox check, at allowlist ay ipinapatupad ng runtime, hindi ng bawat script.
- **Still programmable**: Each step can call any CLI or script. 45. Kung gusto mo ng JS/TS, bumuo ng mga `.lobster` file mula sa code.

## Paano ito gumagana

OpenClaw launches the local `lobster` CLI in **tool mode** and parses a JSON envelope from stdout.
If the pipeline pauses for approval, the tool returns a `resumeToken` so you can continue later.

## Pattern: maliit na CLI + JSON pipes + approvals

46. Bumuo ng maliliit na command na nagsasalita ng JSON, pagkatapos ay i-chain ang mga ito sa isang solong Lobster call. (Example command names below — swap in your own.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

Kung humiling ng approval ang pipeline, i-resume gamit ang token:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI triggers the workflow; Lobster executes the steps. 47. Pinananatiling malinaw at naa-audit ang mga side effect ng mga approval gate.

Halimbawa: i-map ang mga input item papunta sa mga tool call:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only na LLM steps (llm-task)

48. Para sa mga workflow na nangangailangan ng **structured LLM step**, i-enable ang opsyonal na
    `llm-task` plugin tool at tawagin ito mula sa Lobster. This keeps the workflow
    deterministic while still letting you classify/summarize/draft with a model.

I-enable ang tool:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

Gamitin ito sa isang pipeline:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

Tingnan ang [LLM Task](/tools/llm-task) para sa mga detalye at opsyon sa configuration.

## Workflow files (.lobster)

Lobster can run YAML/JSON workflow files with `name`, `args`, `steps`, `env`, `condition`, and `approval` fields. 49. Sa mga OpenClaw tool call, itakda ang `pipeline` sa file path.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Mga tala:

- Ang `stdin: $step.stdout` at `stdin: $step.json` ay nagpapasa ng output ng naunang hakbang.
- Ang `condition` (o `when`) ay puwedeng mag-gate ng mga hakbang batay sa `$step.approved`.

## I-install ang Lobster

50. I-install ang Lobster CLI sa **parehong host** na nagpapatakbo ng OpenClaw Gateway (tingnan ang [Lobster repo](https://github.com/openclaw/lobster)), at tiyaking ang `lobster` ay nasa `PATH`.
51. Kung gusto mong gumamit ng custom na lokasyon ng binary, magpasa ng **absolute** na `lobsterPath` sa tool call.

## I-enable ang tool

Ang Lobster ay isang **optional** na plugin tool (hindi naka-enable bilang default).

Inirerekomenda (additive, ligtas):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

O per-agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

Iwasang gamitin ang `tools.allow: ["lobster"]` maliban kung balak mong tumakbo sa restrictive allowlist mode.

Note: allowlists are opt-in for optional plugins. 2. Kung ang iyong allowlist ay nagbabanggit lamang ng mga plugin tool (tulad ng `lobster`), pinananatiling naka-enable ng OpenClaw ang mga core tool. 3. Upang higpitan ang mga core tool, isama rin sa allowlist ang mga core tool o grupong gusto mo.

## Halimbawa: Email triage

Kung walang Lobster:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

May Lobster:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Nagbabalik ng JSON envelope (pinutol):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

Inaprubahan ng user → i-resume:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

4. Isang workflow. Deterministic. 5. Ligtas.

## Mga parameter ng tool

### `run`

Magpatakbo ng pipeline sa tool mode.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Magpatakbo ng workflow file na may mga arg:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Ipagpatuloy ang isang humintong workflow pagkatapos ng approval.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Mga optional na input

- `lobsterPath`: Absolute na path papunta sa Lobster binary (huwag ilagay para gamitin ang `PATH`).
- `cwd`: Working directory para sa pipeline (default sa kasalukuyang process working directory).
- `timeoutMs`: Patayin ang subprocess kung lumampas sa tagal na ito (default: 20000).
- `maxStdoutBytes`: Patayin ang subprocess kung lumampas ang stdout sa laki na ito (default: 512000).
- `argsJson`: JSON string na ipinapasa sa `lobster run --args-json` (workflow files lang).

## Output envelope

Nagbabalik ang Lobster ng JSON envelope na may isa sa tatlong status:

- `ok` → matagumpay na natapos
- `needs_approval` → naka-pause; kailangan ang `requiresApproval.resumeToken` para mag-resume
- `cancelled` → tahasang tinanggihan o kinansela

Inilalabas ng tool ang envelope sa parehong `content` (pretty JSON) at `details` (raw object).

## Mga approval

Kung naroroon ang `requiresApproval`, suriin ang prompt at magpasya:

- `approve: true` → i-resume at ipagpatuloy ang mga side effect
- `approve: false` → kanselahin at tapusin ang workflow

6. Gamitin ang `approve --preview-from-stdin --limit N` upang mag-attach ng JSON preview sa mga request ng approval nang walang custom jq/heredoc glue. Resume tokens are now compact: Lobster stores workflow resume state under its state dir and hands back a small token key.

## OpenProse

7. Mahusay na magkapareha ang OpenProse at Lobster: gamitin ang `/prose` upang i-orchestrate ang multi-agent prep, pagkatapos ay magpatakbo ng Lobster pipeline para sa deterministikong approvals. 8. Kung kailangan ng isang Prose program ang Lobster, payagan ang `lobster` tool para sa mga sub-agent sa pamamagitan ng `tools.subagents.tools`. 9. Tingnan ang [OpenProse](/prose).

## Safety

- **Local subprocess lang** — walang network call mula mismo sa plugin.
- **Walang secrets** — hindi minamanage ng Lobster ang OAuth; tumatawag ito ng mga OpenClaw tool na gumagawa niyon.
- **Sandbox-aware** — naka-disable kapag sandboxed ang tool context.
- **Hardened** — dapat absolute ang `lobsterPath` kung tinukoy; ipinapatupad ang mga timeout at output cap.

## Pag-troubleshoot

- **`lobster subprocess timed out`** → dagdagan ang `timeoutMs`, o hatiin ang mahabang pipeline.
- **`lobster output exceeded maxStdoutBytes`** → itaas ang `maxStdoutBytes` o bawasan ang laki ng output.
- **`lobster returned invalid JSON`** → tiyaking tumatakbo ang pipeline sa tool mode at JSON lang ang pini-print.
- **`lobster failed (code …)`** → patakbuhin ang parehong pipeline sa terminal para masuri ang stderr.

## Alamin pa

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: mga workflow ng komunidad

10. Isang pampublikong halimbawa: isang “second brain” CLI + Lobster pipelines na namamahala ng tatlong Markdown vault (personal, partner, shared). The CLI emits JSON for stats, inbox listings, and stale scans; Lobster chains those commands into workflows like `weekly-review`, `inbox-triage`, `memory-consolidation`, and `shared-task-sync`, each with approval gates. 11. Hinahawakan ng AI ang paghatol (categorization) kapag available at bumabalik sa mga deterministikong patakaran kapag hindi.

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
