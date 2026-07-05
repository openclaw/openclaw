# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:11:50.140Z
- Finished: 2026-07-03T13:13:19.498Z
- Duration ms: 89358
- Passed: 12
- Failed: 0


## Scenarios

### Model switch follow-up

- Status: pass
- Steps:
  - [x] runs on the default configured model
    - Details: gpt-5.5
  - [x] switches to the alternate model and continues
    - Details: Protocol note: model switch acknowledged. Continuing on gpt-5.5-alt.

### Codex auth profile mixed profiles

- Status: pass
- Steps:
  - [x] validates mixed-profile Codex auth selection
    - Details: selected=openai:qa-oauth rejected=openai:media-api

### Personal no-fake-progress

- Status: pass
- Steps:
  - [x] gates completion claims on local proof
    - Details:

```text
Artifact: personal-progress-proof.txt
Status: local proof artifact written
External status: not sent, not published, not uploaded, not merged
PERSONAL-NO-FAKE-PROGRESS-OK
```

### Late-night deploy helper chat

- Status: pass
- Steps:
  - [x] completes the full natural character chat and records the transcript
    - Details:

```text
ASSISTANT OpenClaw QA: <b>Reefing</b>
<b>📖 Read</b> <code>from personal-progress-proof.txt</code> <i>running</i>

ASSISTANT OpenClaw QA: Protocol note: I reviewed the requested material. Evidence snippet: Personal no-fake-progress Status: local proof artifact written External status: not sent; not published; not uploaded; not merged Evidence: <code>PROGRESS_REQUEST.md</code> and <code>PROGRESS_EVIDENCE.md</code> were read before this artifact was

ASSISTANT OpenClaw QA: <b>Reefing</b>
<b>📖 Read</b> <code>from PROGRESS_REQUEST.md</code> <i>running</i>

ASSISTANT OpenClaw QA: Protocol note: I reviewed the requested material. Evidence snippet: # Progress request Prepare a local proof note for a personal assistant handoff. Required contract: 1. Read <code>PROGRESS_REQUEST.md</code>. 2. Read <code>PROGRESS_EVIDENCE.md</code>. 3. Write ./personal-progress-proof.txt. 4. Include these exact
```

### Compaction retry after mutating tool

- Status: pass
- Steps:
  - [x] keeps replay-unsafety explicit after a mutating write under compaction pressure
    - Details:

```text
Protocol note: replay unsafe after write.
compactionCount=0
status=done
```

### Reasoning-only recovery after replay-safe read

- Status: pass
- Steps:
  - [x] retries a replay-safe read into a visible answer
    - Details:

```text
REASONING-RECOVERED-OK
requests=3
```

### Runtime tool fixture — fs.read

- Status: pass
- Steps:
  - [x] exercises fs.read happy and failure paths
    - Details:

```text
read mock provider happy planned args (diagnostic only): {"path":"QA_KICKOFF_TASK.md"}
read mock provider failure planned args (diagnostic only): {"__qaFailureMode":"denied-input"}
```

### Long-running release audit

- Status: pass
- Steps:
  - [x] completes the sustained release audit with verified artifacts
    - Details:

```text
RELEASE-AUDIT-COMPLETE
{
  "verified": false,
  "findings": [
    {
      "id": "REL-GATEWAY-417",
      "source": "src/gateway/reconnect.ts",
      "status": "retry jitter verified, resume token fallback still needs manual spot check",
      "verified": true
    },
    {
      "id": "REL-CHANNEL-238",
      "source": "src/channels/delivery.ts",
      "status": "thread replies preserve ordering, root-channel fallback needs handoff note",
      "verified": true
    },
    {
      "id": "REL-CRON-904",
      "source": "src/scheduling/cron.ts",
      "status": "single-run lock verified for restart wakeups",
      "verified": true
    },
    {
      "id": "REL-MEMORY-552",
      "source": "src/memory/recall.ts",
      "status": "fallback summary survives empty memory search; ranking sample needs second reviewer",
      "verified": true
    },
    {
      "id": "REL-PLUGIN-319",
      "source": "src/plugins/runtime.ts",
      "status": "bundled runtime manifest loads cleanly after restart",
      "verified": true
    },
    {
      "id": "REL-INSTALL-846",
      "source": "install/update.ts",
      "status": "update smoke passed from previous stable tag",
      "verified": true
    },
    {
      "id": "REL-DOCS-611",
      "source": "docs/operator-notes.md",
      "status": "docs mention reconnect, cron, memory, plugin, and installer checks; channel ordering and UI notes need maintainer handoff",
      "verified": true
    },
    {
      "id": "REL-UI-BLOCKED",
      "source": "ui/control-panel.ts",
      "status": "blocked: source file was referenced by checklist but missing from the fixture",
      "verified": false
    }
  ]
}


# Release Handoff

Ready:
- REL-GATEWAY-417: gateway reconnect handling checked in `src/gateway/reconnect.ts`.
- REL-CRON-904: cron duplicate prevention checked in `src/scheduling/cron.ts`.
- REL-PLUGIN-319: plugin runtime loading checked in `src/plugins/runtime.ts`.
- REL-INSTALL-846: installer update path checked in `install/update.ts`.

Follow-up:
- REL-CHANNEL-238: channel delivery ordering needs maintainer handoff.
- REL-MEMORY-552: memory recall fallback ranking sample needs a second reviewer.
- REL-DOCS-611: docs update status needs channel ordering and UI notes.
- `ui/control-panel.ts` is blocked/not found in the fixture.

```

### Channel baseline conversation

- Status: pass
- Steps:
  - [x] ignores unmentioned channel chatter
  - [x] replies when mentioned in channel
    - Details: QA-CHANNEL-BASELINE-OK

### Crestodian ring-zero setup

- Status: pass
- Steps:
  - [x] bootstraps config through Crestodian CLI
    - Details:

```text
stateDir=/tmp/openclaw/openclaw-qa-suite-r8kJ7b/crestodian-ring-zero-state
configPath=/tmp/openclaw/openclaw-qa-suite-r8kJ7b/crestodian-ring-zero-state/openclaw.json
agent={"id":"reef","name":"reef","workspace":"/tmp/openclaw/openclaw-qa-suite-r8kJ7b/crestodian-reef-workspace","agentDir":"/tmp/openclaw/openclaw-qa-suite-r8kJ7b/crestodian-ring-zero-state/agents/reef/agent","model":"openai/gpt-5.2"}
Discord SecretRef={"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}
```

### Bundled plugin skill runtime

- Status: pass
- Steps:
  - [x] loads a bundled plugin skill from dist-runtime
    - Details:

```text
{
  "exitCode": 0,
  "signal": null,
  "parseError": null,
  "skill": {
    "name": "prose",
    "description": "OpenProse VM skill pack. Activate on any `prose` command, .prose files, or OpenProse mentions; orchestrates multi-agent workflows.",
    "emoji": "🪶",
    "eligible": true,
    "disabled": false,
    "blockedByAllowlist": false,
    "blockedByAgentFilter": false,
    "modelVisible": true,
    "userInvocable": true,
    "commandVisible": true,
    "source": "openclaw-extra",
    "bundled": false,
    "homepage": "https://www.prose.md",
    "missing": {
      "bins": [],
      "anyBins": [],
      "env": [],
      "config": [],
      "os": []
    }
  },
  "skillNames": [
    "clawhub",
    "diagram-maker",
    "gh-issues",
    "github",
    "healthcheck",
    "meme-maker",
    "node-connect",
    "node-inspect-debugger",
    "notion",
    "prose",
    "python-debugpy",
    "session-logs",
    "skill-creator",
    "spike",
    "taskflow",
    "taskflow-inbox-triage",
    "tmux",
    "weather"
  ],
  "skillPath": "dist-runtime/extensions/open-prose/skills/prose/SKILL.md",
  "skillMdSymlink": false,
  "stderr": ""
}
```

### Codex plugin install race

- Status: pass
- Steps:
  - [x] validates deterministic install-race gate
    - Details: expected=QA_CODEX_PLUGIN_TURN_OK count=1


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
