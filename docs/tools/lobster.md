---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: Lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Typed workflow runtime for OpenClaw with resumable approval gates."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want deterministic multi-step workflows with explicit approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to resume a workflow without re-running earlier steps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Lobster is a workflow shell that lets OpenClaw run multi-step tool sequences as a single, deterministic operation with explicit approval checkpoints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your assistant can build the tools that manage itself. Ask for a workflow, and 30 minutes later you have a CLI plus pipelines that run as one call. Lobster is the missing piece: deterministic pipelines, explicit approvals, and resumable state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Today, complex workflows require many back-and-forth tool calls. Each call costs tokens, and the LLM has to orchestrate every step. Lobster moves that orchestration into a typed runtime:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **One call instead of many**: OpenClaw runs one Lobster tool call and gets a structured result.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Approvals built in**: Side effects (send email, post comment) halt the workflow until explicitly approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Resumable**: Halted workflows return a token; approve and resume without re-running everything.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why a DSL instead of plain programs?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Lobster is intentionally small. The goal is not "a new language," it's a predictable, AI-friendly pipeline spec with first-class approvals and resume tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Approve/resume is built in**: A normal program can prompt a human, but it can’t _pause and resume_ with a durable token without you inventing that runtime yourself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Determinism + auditability**: Pipelines are data, so they’re easy to log, diff, replay, and review.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Constrained surface for AI**: A tiny grammar + JSON piping reduces “creative” code paths and makes validation realistic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Safety policy baked in**: Timeouts, output caps, sandbox checks, and allowlists are enforced by the runtime, not each script.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Still programmable**: Each step can call any CLI or script. If you want JS/TS, generate `.lobster` files from code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw launches the local `lobster` CLI in **tool mode** and parses a JSON envelope from stdout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the pipeline pauses for approval, the tool returns a `resumeToken` so you can continue later.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pattern: small CLI + JSON pipes + approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Build tiny commands that speak JSON, then chain them into a single Lobster call. (Example command names below — swap in your own.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
inbox list --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
inbox categorize --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
inbox apply --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "run",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "timeoutMs": 30000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the pipeline requests approval, resume with the token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "resume",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "token": "<resumeToken>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "approve": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
AI triggers the workflow; Lobster executes the steps. Approval gates keep side effects explicit and auditable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: map input items into tool calls:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gog.gmail.search --query 'newer_than:1d' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## JSON-only LLM steps (llm-task)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For workflows that need a **structured LLM step**, enable the optional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`llm-task` plugin tool and call it from Lobster. This keeps the workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
deterministic while still letting you classify/summarize/draft with a model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable the tool:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "plugins": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "llm-task": { "enabled": true }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": { "allow": ["llm-task"] }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use it in a pipeline:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw.invoke --tool llm-task --action json --args-json '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "prompt": "Given the input email, return intent and draft.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "input": { "subject": "Hello", "body": "Can you help?" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "schema": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "type": "object",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "properties": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "intent": { "type": "string" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "draft": { "type": "string" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "required": ["intent", "draft"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "additionalProperties": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [LLM Task](/tools/llm-task) for details and configuration options.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Workflow files (.lobster)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Lobster can run YAML/JSON workflow files with `name`, `args`, `steps`, `env`, `condition`, and `approval` fields. In OpenClaw tool calls, set `pipeline` to the file path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: inbox-triage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
args:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tag:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    default: "family"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
steps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - id: collect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    command: inbox list --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - id: categorize（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    command: inbox categorize --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    stdin: $collect.stdout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - id: approve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    command: inbox apply --approve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    stdin: $categorize.stdout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    approval: required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - id: execute（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    command: inbox apply --execute（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    stdin: $categorize.stdout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    condition: $approve.approved（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `stdin: $step.stdout` and `stdin: $step.json` pass a prior step’s output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `condition` (or `when`) can gate steps on `$step.approved`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install Lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install the Lobster CLI on the **same host** that runs the OpenClaw Gateway (see the [Lobster repo](https://github.com/openclaw/lobster)), and ensure `lobster` is on `PATH`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want to use a custom binary location, pass an **absolute** `lobsterPath` in the tool call.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enable the tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Lobster is an **optional** plugin tool (not enabled by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended (additive, safe):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "alsoAllow": ["lobster"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or per-agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "list": [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "id": "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "tools": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "alsoAllow": ["lobster"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Avoid using `tools.allow: ["lobster"]` unless you intend to run in restrictive allowlist mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: allowlists are opt-in for optional plugins. If your allowlist only names（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
plugin tools (like `lobster`), OpenClaw keeps core tools enabled. To restrict core（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tools, include the core tools or groups you want in the allowlist too.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example: Email triage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Without Lobster:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
User: "Check my email and draft replies"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
→ openclaw calls gmail.list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
→ LLM summarizes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
→ User: "draft replies to #2 and #5"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
→ LLM drafts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
→ User: "send #2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
→ openclaw calls gmail.send（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(repeat daily, no memory of what was triaged)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
With Lobster:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "run",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "pipeline": "email.triage --limit 20",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "timeoutMs": 30000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Returns a JSON envelope (truncated):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "ok": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "status": "needs_approval",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "output": [{ "summary": "5 need replies, 2 need action" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "requiresApproval": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "type": "approval_request",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "prompt": "Send 2 draft replies?",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "items": [],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "resumeToken": "..."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
User approves → resume:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "resume",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "token": "<resumeToken>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "approve": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One workflow. Deterministic. Safe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `run`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a pipeline in tool mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "run",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "cwd": "/path/to/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "timeoutMs": 30000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "maxStdoutBytes": 512000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a workflow file with args:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "run",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "pipeline": "/path/to/inbox-triage.lobster",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "argsJson": "{\"tag\":\"family\"}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `resume`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Continue a halted workflow after approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "resume",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "token": "<resumeToken>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "approve": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Optional inputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `lobsterPath`: Absolute path to the Lobster binary (omit to use `PATH`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cwd`: Working directory for the pipeline (defaults to the current process working directory).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutMs`: Kill the subprocess if it exceeds this duration (default: 20000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxStdoutBytes`: Kill the subprocess if stdout exceeds this size (default: 512000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `argsJson`: JSON string passed to `lobster run --args-json` (workflow files only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Output envelope（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Lobster returns a JSON envelope with one of three statuses:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ok` → finished successfully（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `needs_approval` → paused; `requiresApproval.resumeToken` is required to resume（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cancelled` → explicitly denied or cancelled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The tool surfaces the envelope in both `content` (pretty JSON) and `details` (raw object).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `requiresApproval` is present, inspect the prompt and decide:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `approve: true` → resume and continue side effects（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `approve: false` → cancel and finalize the workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `approve --preview-from-stdin --limit N` to attach a JSON preview to approval requests without custom jq/heredoc glue. Resume tokens are now compact: Lobster stores workflow resume state under its state dir and hands back a small token key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## OpenProse（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse pairs well with Lobster: use `/prose` to orchestrate multi-agent prep, then run a Lobster pipeline for deterministic approvals. If a Prose program needs Lobster, allow the `lobster` tool for sub-agents via `tools.subagents.tools`. See [OpenProse](/prose).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local subprocess only** — no network calls from the plugin itself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No secrets** — Lobster doesn't manage OAuth; it calls OpenClaw tools that do.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sandbox-aware** — disabled when the tool context is sandboxed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hardened** — `lobsterPath` must be absolute if specified; timeouts and output caps enforced.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`lobster subprocess timed out`** → increase `timeoutMs`, or split a long pipeline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`lobster output exceeded maxStdoutBytes`** → raise `maxStdoutBytes` or reduce output size.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`lobster returned invalid JSON`** → ensure the pipeline runs in tool mode and prints only JSON.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`lobster failed (code …)`** → run the same pipeline in a terminal to inspect stderr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Learn more（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Plugin tool authoring](/plugins/agent-tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Case study: community workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One public example: a “second brain” CLI + Lobster pipelines that manage three Markdown vaults (personal, partner, shared). The CLI emits JSON for stats, inbox listings, and stale scans; Lobster chains those commands into workflows like `weekly-review`, `inbox-triage`, `memory-consolidation`, and `shared-task-sync`, each with approval gates. AI handles judgment (categorization) when available and falls back to deterministic rules when not.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
