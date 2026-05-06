---
summary: "Functional test plan for strict tool mode behavior and report contracts"
read_when:
  - Verifying strict tool mode before release
  - Testing tool-call fidelity regressions
  - Building an evaluation lane that consumes tool strictness reports
title: "Strict Tool Mode Testing"
---

# Strict Tool Mode Testing

Strict tool mode keeps normal OpenClaw usage permissive while giving training and evaluation lanes a way to detect or reject non-canonical tool calls.

This page describes the functional checks that prove the strict tool mode contract end to end.

## What To Verify

Strict tool mode has three public modes:

- `off`: preserve the default permissive product behavior.
- `warn`: keep compatibility behavior, but record each repair in `toolStrictnessReport`.
- `strict`: reject compatibility behavior that would hide a model tool-call fidelity error.

The functional surface is complete only when these behaviors hold across the agent runner, provider transports, tool handlers, and gateway HTTP responses.

## Core Checks

Run the focused checks first:

```bash
OPENCLAW_LOCAL_CHECK=0 pnpm exec vitest run --config test/vitest/vitest.agents.config.ts src/agents/pi-embedded-runner/run/attempt.test.ts --reporter dot
OPENCLAW_LOCAL_CHECK=0 pnpm test src/agents/anthropic-transport-stream.test.ts extensions/google/transport-stream.test.ts
OPENCLAW_LOCAL_CHECK=0 OPENCLAW_VITEST_POOL=forks pnpm exec vitest run --config test/vitest/vitest.gateway.config.ts src/gateway/openai-http.test.ts src/gateway/openresponses-http.test.ts --pool=forks --reporter dot
OPENCLAW_LOCAL_CHECK=0 pnpm tsgo
```

The gateway command starts local HTTP listeners. If your sandbox blocks `127.0.0.1`, run that command in an environment that allows local loopback binds.

## Expected Coverage

The focused checks should prove:

| Behavior                                                | Expected result                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| JSON-string tool arguments in `warn`                    | Arguments are parsed and `argumentShapeRepair` is recorded.                                |
| JSON-string tool arguments in `strict`                  | The provider payload build fails with a strict tool mode error.                            |
| `read.file_path` in `warn`                              | The alias is accepted and `argumentKeyAlias` is recorded.                                  |
| `read.file_path` in `strict`                            | The tool call is rejected with an alias error.                                             |
| Provider-prefixed or malformed tool names in `warn`     | The name is normalized and `toolNameNormalization` is recorded.                            |
| Provider-prefixed or malformed tool names in `strict`   | The name is not normalized. Unknown-tool or replay validation exposes the failure.         |
| Replay `tool_call` or `functionCall` blocks in `strict` | The replay sanitizer records the compatibility hit, then hard fails.                       |
| Per-request `tool_strictness_mode`                      | The HTTP request value overrides config and env defaults.                                  |
| Non-streaming gateway responses                         | `tool_strictness_report` appears in the JSON body when a report exists.                    |
| Streaming gateway responses                             | A final metadata chunk or event carries `tool_strictness_report` before stream completion. |

## HTTP Contract

Both OpenAI-compatible endpoints accept either spelling:

```json
{
  "tool_strictness_mode": "warn"
}
```

```json
{
  "toolStrictnessMode": "strict"
}
```

Allowed values are `off`, `warn`, and `strict`. Invalid values must return a request validation error.

## Non-Streaming Reports

For Chat Completions and OpenResponses non-streaming calls, the report is included as `tool_strictness_report` in the response body when a report exists.

The minimum stable fields for evaluation consumers are:

```json
{
  "tool_strictness_report": {
    "repairs": [],
    "summary": {
      "repairCount": 0,
      "hadAnyRepair": false,
      "repairKindCounts": {
        "argumentKeyAlias": 0,
        "argumentShapeRepair": 0,
        "toolNameNormalization": 0
      }
    }
  }
}
```

Consumers should prefer `summary` for filtering and use `repairs` for audit detail.

## Streaming Reports

Streaming responses emit the report near the end of the stream when a report exists.

Chat Completions emits a data-only metadata chunk before `[DONE]`:

```json
{
  "object": "chat.completion.tool_strictness_report",
  "choices": [],
  "tool_strictness_report": {
    "summary": {
      "repairCount": 1
    }
  }
}
```

OpenResponses emits a typed SSE event before `response.completed`:

```text
event: response.tool_strictness_report
data: {"type":"response.tool_strictness_report","tool_strictness_report":{"summary":{"repairCount":1}}}
```

Evaluation clients that use streaming should buffer or inspect these terminal metadata events before deciding whether a sample is clean, repaired, or strict-failure related.

## Functional Scenarios

Use these scenario shapes for manual or fixture-based evaluation:

1. Clean canonical call
   - Mode: `warn`
   - Tool name: `read`
   - Arguments: `{ "path": "README.md" }`
   - Expected: `repairCount = 0`

2. Argument shape repair
   - Mode: `warn`
   - Tool name: `read`
   - Arguments: stringified JSON
   - Expected: successful run and `repairKindCounts.argumentShapeRepair = 1`
   - Mode: `strict`
   - Expected: strict rejection

3. Alias key repair
   - Mode: `warn`
   - Tool name: `read`
   - Arguments: `{ "file_path": "README.md" }`
   - Expected: successful run and `repairKindCounts.argumentKeyAlias = 1`
   - Mode: `strict`
   - Expected: strict rejection

4. Tool name normalization
   - Mode: `warn`
   - Tool name: `functions.read` or equivalent malformed provider style
   - Expected: successful run and `repairKindCounts.toolNameNormalization = 1`
   - Mode: `strict`
   - Expected: no name normalization

5. Replay block compatibility
   - Mode: `strict`
   - Replay block type: `tool_call` or `functionCall`
   - Expected: compatibility event is recorded before strict rejection

## Pass Criteria

The feature is ready for evaluation use when:

- The focused test commands pass.
- `pnpm tsgo` passes.
- Non-streaming HTTP responses expose `tool_strictness_report`.
- Streaming HTTP responses expose terminal strictness metadata before completion.
- `warn` mode records repairs without changing user-facing default permissive behavior.
- `strict` mode rejects the compatibility repairs that would hide tool-call fidelity errors.
