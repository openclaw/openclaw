# OpenClaw hook capability smoke report

Generated: 2026-04-28T02:28:54.567Z
OpenClaw package version: 2026.4.26
Result: **PASS**

## Capability checks

| Status | Check                                                                         | File                                                                           | Detail                                                                                  |
| ------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| ✅     | llm_input is observe-only in the installed/source hook contract               | `src/plugins/hook-types.ts`                                                    | expected llm_input handler return type Promise<void> \| void                            |
| ✅     | llm_output is observe-only in the installed/source hook contract              | `src/plugins/hook-types.ts`                                                    | expected llm_output handler return type Promise<void> \| void                           |
| ✅     | plugin shape inspection keeps typed hooks separate from explicit capabilities | `src/plugins/inspect-shape.ts`                                                 | expected inspect-shape to classify typed hooks separately from capability registrations |
| ✅     | before_tool_call remains a modifying/blocking hook                            | `src/plugins/hook-types.ts`                                                    | expected before_tool_call to reference PluginHookBeforeToolCallResult                   |
| ✅     | Codex dynamic tools have fail-closed before_tool_call coverage                | `extensions/codex/src/app-server/openclaw-owned-tool-runtime-contract.test.ts` | expected Codex dynamic tool blocking contract test                                      |
| ✅     | Codex dynamic tools have after_tool_call observation coverage                 | `extensions/codex/src/app-server/openclaw-owned-tool-runtime-contract.test.ts` | expected Codex dynamic tool before/after contract test                                  |
| ✅     | Codex native PreToolUse relay has a blocking parity test                      | `src/agents/harness/native-hook-relay.test.ts`                                 | expected native relay test for Codex PreToolUse blocking                                |
| ✅     | Codex native PostToolUse relay has an observation parity test                 | `src/agents/harness/native-hook-relay.test.ts`                                 | expected native relay test for Codex PostToolUse observation                            |
| ✅     | OpenClaw-owned Pi tools have fail-closed before_tool_call coverage            | `src/agents/openclaw-owned-tool-runtime-contract.test.ts`                      | expected Pi dynamic tool blocking contract test                                         |
| ✅     | OpenClaw-owned Pi tools have after_tool_call observation coverage             | `src/agents/openclaw-owned-tool-runtime-contract.test.ts`                      | expected Pi dynamic tool after_tool_call contract test                                  |

## Focused verification

Command: `node scripts/run-vitest.mjs run src/agents/openclaw-owned-tool-runtime-contract.test.ts extensions/codex/src/app-server/openclaw-owned-tool-runtime-contract.test.ts src/agents/harness/native-hook-relay.test.ts src/plugins/wired-hooks-llm.test.ts`

Status: 0

```text
RUN  v4.1.5 /mnt/iris_gateway_data_100gb/repos/openclaw-hook-capability-smoke-9f6c25b3

 ✓  agents-core  ../../src/agents/harness/native-hook-relay.test.ts (33 tests) 346ms
 ✓  agents-core  ../../src/agents/openclaw-owned-tool-runtime-contract.test.ts (4 tests) 60ms
 ✓  agents-support  ../../src/agents/harness/native-hook-relay.test.ts (33 tests) 317ms
 ✓  agents-support  ../../src/agents/openclaw-owned-tool-runtime-contract.test.ts (4 tests) 67ms
 ✓  extensions  ../../extensions/codex/src/app-server/openclaw-owned-tool-runtime-contract.test.ts (7 tests) 115ms
 ✓  plugins  ../../src/plugins/wired-hooks-llm.test.ts (5 tests) 455ms
     ✓ 'runModelCallStarted invokes registere…'  445ms

 Test Files  6 passed (6)
      Tests  86 passed (86)
   Start at  22:28:11
   Duration  42.68s (transform 27.76s, setup 2.79s, import 37.36s, tests 1.36s, environment 1ms)
stderr | ../../src/agents/openclaw-owned-tool-runtime-contract.test.ts > OpenClaw-owned tool runtime contract — Pi adapter > reports Pi dynamic tool execution errors through after_tool_call
[tools] exec failed: tool failed raw_params={"command":"false"}

stderr | ../../src/agents/openclaw-owned-tool-runtime-contract.test.ts > OpenClaw-owned tool runtime contract — Pi adapter > reports Pi dynamic tool execution errors through after_tool_call
[tools] exec failed: tool failed raw_params={"command":"false"}
```

## Interpretation

- OpenClaw-owned Pi tools and Codex app-server dynamic tools are expected to fail closed through `before_tool_call` and emit `after_tool_call` observations.
- Codex-native `PreToolUse`/`PostToolUse` relay is expected to reach the same OpenClaw hook surfaces for harmless sentinel actions.
- `llm_input` and `llm_output` stay typed-hook, observe-only surfaces in the current source/inspect contract; do not depend on prompt/response mutation until stable source/types change.
- This is a dry-run upgrade gate. It does not enable fail-closed production enforcement by itself, and any production fail-closed rollout still needs Iris review.
