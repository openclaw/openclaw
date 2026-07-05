# OpenClaw QA Scenario Suite

- Started: 2026-07-03T13:11:50.141Z
- Finished: 2026-07-03T13:13:09.839Z
- Duration ms: 79698
- Passed: 11
- Failed: 0


## Scenarios

### Anthropic Opus API key smoke

- Status: pass
- Steps:
  - [x] confirms regular Anthropic API-key lane
    - Details: mock-compatible provider=mock-openai
  - [x] talks through regular Anthropic Opus
    - Details: mock mode: skipped live Anthropic smoke

### Subagent completion direct fallback

- Status: pass
- Steps:
  - [x] yielded parent receives child completion through direct fallback
    - Details: QA-SUBAGENT-DIRECT-FALLBACK-OK

### Subagent fanout synthesis

- Status: pass
- Steps:
  - [x] spawns sequential workers and folds both results back into the parent reply
    - Details:

```text
subagent-1: ok
subagent-2: ok
```

### Personal tool safety followthrough

- Status: pass
- Steps:
  - [x] turns short approval into a safe read-backed answer
    - Details: PERSONAL-TOOL-SAFETY-OK

### Empty-response retry budget exhausted

- Status: pass
- Steps:
  - [x] surfaces a retry error after empty-response exhaustion
    - Details: requests=5

### Runtime tool fixture — edit

- Status: pass
- Steps:
  - [x] exercises edit happy and failure paths
    - Details:

```text
edit mock provider happy planned args (diagnostic only): {"path":"runtime-tool-fixture-edit.txt","edits":[{"oldText":"before edit\n","newText":"after edit\n"}]}
edit mock provider failure planned args (diagnostic only): {"__qaFailureMode":"denied-input"}
```

### Runtime tool fixture — grep

- Status: pass
- Steps:
  - [x] exercises grep happy and failure paths
    - Details:

```text
exec mock provider happy planned args (diagnostic only): {"command":"echo runtime-tool-fixture","timeout":5}
exec mock provider failure planned args (diagnostic only): {"__qaFailureMode":"denied-input"}
```

### Personal share-safe diagnostics artifact

- Status: pass
- Steps:
  - [x] writes a useful share-safe diagnostics artifact
    - Details:

```text
Artifact: personal-diagnostics-summary.txt
Status: share-safe diagnostics summary ready
PERSONAL-DIAGNOSTICS-SAFE-OK
```

### Runtime tool fixture — bash

- Status: pass
- Steps:
  - [x] exercises bash happy and failure paths
    - Details:

```text
exec mock provider happy planned args (diagnostic only): {"command":"echo runtime-tool-fixture","timeout":5}
exec mock provider failure planned args (diagnostic only): {"__qaFailureMode":"denied-input"}
```

### Runtime tool fixture — session_status

- Status: pass
- Steps:
  - [x] exercises session_status happy and failure paths
    - Details:

```text
session_status mock provider happy planned args (diagnostic only): {"sessionKey":"current"}
session_status mock provider failure planned args (diagnostic only): {"__qaFailureMode":"denied-input"}
```

### Source and docs discovery report

- Status: pass
- Steps:
  - [x] reads seeded material and emits a protocol report
    - Details:

```text
Worked:

• Read seeded QA material.
• Expanded the report structure.
Failed:
• None observed in mock mode.
Blocked:
• No live provider evidence in this lane.
Follow-up:
• Re-run with a real model for qualitative coverage.
```


## Notes

- Runs OpenClaw's telegram channel plugin against a Crabline local provider server.
- No live channel service or external credential lease is required.
- Channel driver: crabline local provider for telegram.
- Channel capability report: crabline-fake-provider-capabilities.json.
- Channel driver smoke: crabline-fake-provider-smoke.json.
- Crabline starts local provider-shaped servers; OpenClaw uses its normal channel adapter against those endpoints.
