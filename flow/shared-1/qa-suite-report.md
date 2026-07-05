# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:11:50.140Z
- Finished: 2026-07-03T13:12:50.924Z
- Duration ms: 60784
- Passed: 12
- Failed: 0


## Scenarios

### GPT-5.5 thinking visibility switch

- Status: pass
- Steps:
  - [x] enables reasoning display and disables thinking
    - Details: reasoning ack=⚙️ Reasoning visibility enabled.; thinking off=Thinking disabled.; off answer=THINKING-OFF-OK
  - [x] switches to medium thinking
    - Details: thinking medium=Thinking level set to medium.
  - [x] verifies medium thinking reaches the provider
    - Details: answer=THINKING-MAX-OK; medium reasoning=medium; crabline suppresses reasoning delivery

### Anthropic Opus setup-token smoke

- Status: pass
- Steps:
  - [x] confirms regular Anthropic setup-token lane
    - Details: mock-compatible provider=mock-openai
  - [x] talks through regular Anthropic Opus
    - Details: mock mode: skipped live Anthropic smoke

### Personal failure recovery

- Status: pass
- Steps:
  - [x] reports partial failure with retry boundary
    - Details:

```text
Artifact: personal-failure-recovery.txt
Failed step: external calendar update was not attempted
Retry boundary: do not retry until approval is given
PERSONAL-FAILURE-RECOVERY-OK
```

### Nervous release protocol chat

- Status: pass
- Steps:
  - [x] completes the full natural C-3PO chat and records the transcript
    - Details:

```text
ASSISTANT OpenClaw QA: THINKING-MAX-OK

ASSISTANT OpenClaw QA: THINKING-MAX-OK

ASSISTANT OpenClaw QA: THINKING-MAX-OK

ASSISTANT OpenClaw QA: THINKING-MAX-OK
```

### Approval turn tool followthrough

- Status: pass
- Steps:
  - [x] turns short approval into a real file read
    - Details: Protocol note: I reviewed the requested material. Evidence snippet: QA mission: Understand this OpenClaw repo from source + docs before acting. The repo is available in your workspace at <code>./repo/</code>. Use the seeded QA scenario plan as your baseline, then add more scenarios if the code/docs

### Reasoning-only no-auto-retry after write

- Status: pass
- Steps:
  - [x] keeps replay-unsafety explicit after a mutating write
    - Details: requests=2 sideEffect=side effects already happened

### Runtime tool fixture — fs.list

- Status: pass
- Steps:
  - [x] exercises fs.list happy and failure paths
    - Details:

```text
read mock provider happy planned args (diagnostic only): {"path":"QA_KICKOFF_TASK.md"}
read mock provider failure planned args (diagnostic only): {"__qaFailureMode":"denied-input"}
```

### Build Lobster Invaders

- Status: pass
- Steps:
  - [x] creates the artifact after reading context
    - Details: lobster-invaders.html

### Secret redaction tool logs

- Status: pass
- Steps:
  - [x] reads fake secret context without echoing it
    - Details: SECRET-REDACTION-OK

### Runtime tool fixture — exec

- Status: pass
- Steps:
  - [x] exercises exec happy and failure paths
    - Details:

```text
exec mock provider happy planned args (diagnostic only): {"command":"echo runtime-tool-fixture","timeout":5}
exec mock provider failure planned args (diagnostic only): {"__qaFailureMode":"denied-input"}
```

### Runtime tool fixture — tts

- Status: pass
- Steps:
  - [x] exercises or records tts coverage
    - Details:

```text
expected-unavailable tts: this fixture is report-only for the current profile
available tools: apply_patch, create_goal, cron, edit, exec, get_goal, memory_get, memory_search, process, read, session_status, sessions_history, sessions_list, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, update_goal, update_plan, web_fetch, web_search, write
```

### Codex plugin cold install

- Status: pass
- Steps:
  - [x] validates cold-install repair routing
    - Details: missing=repair-required repaired=ready route=codex-oauth


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
