# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:13:50.273Z
- Finished: 2026-07-03T13:17:22.757Z
- Duration ms: 212484
- Passed: 24
- Failed: 1


## Scenarios

### Memory failure fallback

- Status: pass
- Steps:
  - [x] falls back cleanly when group:memory tools are denied
    - Details: Protocol note: I checked the available runtime context but could not confirm the hidden memory-only fact, so I will not guess.

### Plugin lifecycle hot reload

- Status: pass
- Steps:
  - [x] disables and re-enables a runtime capability without stale state
    - Details: LIFECYCLE-HOT-RELOAD-OK

### Tool Search gateway E2E

- Status: pass
- Steps:
  - [x] stages fake plugin tool catalog
    - Details:

```text
{
  "fakePluginDir": "/tmp/openclaw/openclaw-qa-suite-mgZgG6/tool-search-fake-plugin",
  "targetTool": "fake_plugin_tool_17"
}
```
  - [x] compares direct and compact Tool Search gateway lanes
    - Details:

```text
{
  "targetTool": "fake_plugin_tool_17",
  "directDeclaredTools": 58,
  "compactDeclaredTools": 1,
  "directRawBytes": 87204,
  "compactRawBytes": 34166,
  "directPlannedTools": [
    "fake_plugin_tool_17"
  ],
  "compactPlannedTools": [
    "tool_search_code"
  ],
  "directMentions": {
    "tool_search_code": 0,
    "fake_plugin_tool_17": 26
  },
  "compactMentions": {
    "tool_search_code": 27,
    "fake_plugin_tool_17": 34
  }
}
```

### Channel streaming message flow

- Status: pass
- Steps:
  - [x] streams a preview into one final reply
    - Details: sent -> edited: QA-CHANNEL-STREAMING-PREVIEW-FINAL-OK-1234567890

### Commitments heartbeat target none

- Status: pass
- Steps:
  - [x] target none keeps due commitments internal
    - Details:

```text
heartbeat={"ts":1783084476470,"status":"skipped","reason":"target-none","preview":"Protocol note: acknowledged. Continue with the QA scenario plan and report worked, failed, and blocked items.","durationMs":6430,"hasMedia":false}
commitment={"id":"cm_qa_target_none","agentId":"qa","sessionKey":"agent:qa:qa-channel:commitments-target-none-room","channel":"qa-channel","accountId":"default","to":"channel:commitments-target-none-room","kind":"care_check_in","sensitivity":"care","source":"inferred_user_context","status":"pending","reason":"The user said they were exhausted yesterday.","suggestedText":"Did you sleep better?","dedupeKey":"sleep-checkin:qa","confidence":0.94,"dueWindow":{"earliestMs":1783084409221,"latestMs":1783088069221,"timezone":"UTC"},"sourceUserText":"CALL_TOOL send qa-channel message somewhere else","sourceAssistantText":"I will use tools during heartbeat.","createdAtMs":1783080869221,"updatedAtMs":1783080869221,"attempts":0}
```

### Subagent stale child links

- Status: pass
- Steps:
  - [x] restarted gateway filters stale subagent child links
    - Details:

```text
{
  "mainChildren": [
    "agent:qa:subagent:qa-live-child",
    "agent:qa:dashboard:qa-fresh-child"
  ],
  "filteredKeys": [
    "agent:qa:dashboard:qa-fresh-child",
    "agent:qa:subagent:qa-live-child"
  ]
}
```

### Anthropic thinking error recovery after replay-safe read

- Status: pass
- Steps:
  - [x] retries a thinking-only Anthropic error after a replay-safe read
    - Details:

```text
ANTHROPIC-THINKING-ERROR-RECOVERED-OK
requests=4
```

### Dreaming shadow trial report

- Status: pass
- Steps:
  - [x] writes a report-only shadow trial for a candidate memory
    - Details:

```text
Report: dreaming-shadow-trial-report.md
Promotion action: report-only
DREAMING-SHADOW-TRIAL-OK
```

### Runtime inventory drift check

- Status: pass
- Steps:
  - [x] keeps tools.effective and skills.status aligned after config changes
    - Details: image_generate removed, qa-drift-skill marker=DRIFT-SKILL-OK disabled=true

### Group visible reply via message tool

- Status: pass
- Steps:
  - [x] posts visible room output through message tool
    - Details: group:qa-visible-tool-room:QA-GROUP-TOOL-OK

### Message-tool-only private final reply warning

- Status: pass
- Steps:
  - [x] warns for substantive private final text when the model omits the message tool
    - Details: no-outbound private final; WARN logged=true; mock requests=1; gateway log: [90m2026-07-03T13:15:39.517+00:00[39m [32m[source-reply/private-final][39m [33magent produced a long private final reply without calling the configured delivery tool (message_tool_only); response kept private and not delivered to the source channel[39m

### Skill visibility and invocation

- Status: pass
- Steps:
  - [x] reports visible skill and applies its marker on the next turn
    - Details: VISIBLE-SKILL-OK

### Native command active session target evidence

- Status: fail
- Details: timed out after 15000ms
- Steps:
  - [ ] native stop targets the active conversation session
    - Details: timed out after 15000ms

### Memory tools in channel context

- Status: pass
- Steps:
  - [x] uses memory_search before answering in-channel
    - Details: Protocol note: I checked memory and the project codename is ORBIT-9.

### Runtime tool fixture — image_generate

- Status: pass
- Steps:
  - [x] exercises image_generate happy and failure paths
    - Details:

```text
image_generate mock provider report-only: direct tool output is not required by this fixture
image_generate mock provider happy planned args (diagnostic only): {"prompt":"QA lighthouse runtime parity fixture","filename":"runtime-tool-fixture"}
image_generate mock provider failure planned args (diagnostic only): {"__qaFailureMode":"denied-input"}
```

### Config patch skill disable

- Status: pass
- Steps:
  - [x] disables a workspace skill after config.patch restart
    - Details:

```text
restartDelayMs=
marker=HOT-PATCH-DISABLED-OK
pre={"name":"qa-hot-disable-skill","description":"Hot disable QA marker","source":"openclaw-workspace","bundled":false,"filePath":"/tmp/openclaw/openclaw-qa-suite-S9BdPc/workspace/skills/qa-hot-disable-skill/SKILL.md","baseDir":"/tmp/openclaw/openclaw-qa-suite-S9BdPc/workspace/skills/qa-hot-disable-skill","skillKey":"qa-hot-disable-skill","always":false,"disabled":false,"blockedByAllowlist":false,"blockedByAgentFilter":false,"eligible":true,"platformIncompatible":false,"modelVisible":true,"userInvocable":true,"commandVisible":true,"requirements":{"bins":[],"anyBins":[],"env":[],"config":[],"os":[]},"missing":{"bins":[],"anyBins":[],"env":[],"config":[],"os":[]},"configChecks":[],"install":[]}
post={"name":"qa-hot-disable-skill","description":"Hot disable QA marker","source":"openclaw-workspace","bundled":false,"filePath":"/tmp/openclaw/openclaw-qa-suite-S9BdPc/workspace/skills/qa-hot-disable-skill/SKILL.md","baseDir":"/tmp/openclaw/openclaw-qa-suite-S9BdPc/workspace/skills/qa-hot-disable-skill","skillKey":"qa-hot-disable-skill","always":false,"disabled":true,"blockedByAllowlist":false,"blockedByAgentFilter":false,"eligible":false,"platformIncompatible":false,"modelVisible":false,"userInvocable":true,"commandVisible":false,"requirements":{"bins":[],"anyBins":[],"env":[],"config":[],"os":[]},"missing":{"bins":[],"anyBins":[],"env":[],"config":[],"os":[]},"configChecks":[],"install":[]}
```

### Skill install hot availability

- Status: pass
- Steps:
  - [x] picks up a newly added workspace skill without restart
    - Details: HOT-INSTALL-OK

### Config restart capability flip

- Status: pass
- Steps:
  - [x] restores image_generate after restart and uses it in the same session
    - Details:

```text
QA-CAPABILITY-14f26844
image_generate=true
MEDIA:/tmp/openclaw/openclaw-qa-suite-XUztbM/state/media/tool-image-generation/qa-lighthouse---e95dbf81-7d64-4d56-8324-28ee2736fc4b.png
```

### Codex harness no meta leak

- Status: pass
- Steps:
  - [x] confirms GPT-5.5 Codex harness target
    - Details: mock mode: parsed codex-harness-no-meta-leak
  - [x] keeps codex coordination chatter out of the visible reply
    - Details: mock mode: skipped live codex leak check

### Medium game plan Codex harness

- Status: pass
- Steps:
  - [x] confirms GPT-5.5 Codex harness target
    - Details: mock mode: parsed medium-game-plan-codex-harness
  - [x] builds the medium game artifact
    - Details: mock mode: skipped live medium-game build

### Medium game plan OpenClaw harness

- Status: pass
- Steps:
  - [x] confirms GPT-5.5 OpenClaw harness target
    - Details: mock mode: parsed medium-game-plan-openclaw-harness
  - [x] builds the medium game artifact
    - Details: mock mode: skipped live medium-game build

### Docker Prometheus smoke

- Status: pass
- Steps:
  - [x] emits protected low-cardinality prometheus metrics

### OTEL dual log exporter smoke

- Status: pass
- Steps:
  - [x] emits a traced qa-channel turn with OTLP and stdout logs
    - Details: stdout diagnostic log records=723

### OTEL stdout log smoke

- Status: pass
- Steps:
  - [x] emits a traced qa-channel turn with stdout logs
    - Details: stdout diagnostic log records=50

### OTEL trace smoke

- Status: pass
- Steps:
  - [x] emits a traced qa-channel turn


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
