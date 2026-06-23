# SEMI-AUTO-RUN-017 — B Group Materialize Root Cause Analysis

**Date:** 2026-06-24 04:15 KST  
**Grade:** 🟢 Auto (read-only)  
**Status:** ✅ COMPLETE

---

## 1. Failed Test

**File:** `src/agents/agent-bundle-mcp-tools.materialize.test.ts`  
**Test name:** `"passes selected MCP servers into catalog materialization without recataloging on execution"`

### Expected vs Actual

```typescript
// Test expects:
expectTextContentBlock(result.content[0], "FROM-TAVILY");

// But gets:
// "Action blocked by plugin policy: approval required. Capability: write."
// Because PLUGIN-RUNTIME-BLOCK-003 intercepts the execution.
```

### The assertion that fails

`expectTextContentBlock(result.content[0], "FROM-TAVILY")` — the test expects the mock MCP server's real response ("FROM-TAVILY"), but the new policy gate returns a blocked message.

---

## 2. Call Path Trace

```
test calls materialized.tools[0].execute(...)
  → buildBundleMcpToolsFromCatalog.createExecute(tool) closure
    → decideToolCallCapabilityCached("bundle_probe")
      → decideToolCallCapability("bundle_probe")
        → TOOL_READ_PATTERN.test("bundle_probe")     ❌ no match
        → TOOL_WRITE_PATTERN.test("bundle_probe")     ❌ no match
        → TOOL_DESTRUCTIVE_PATTERN.test("bundle_probe")   ❌ no match
        → ...all patterns miss...
        → default fallback: return ["write"]              ← HERE
    → guardPluginActionRuntime({ name: "bundle_probe", capabilities: ["write"] })
      → decidePluginActionPolicy({ capabilities: ["write"] })
        → "write" ∈ approvalRequiredCapabilities = true
        → return { kind: "approval_required" }
      → return { ok: false, decision: "approval_required" }
    → format blocked result ← TEST FAILS HERE
    → return { content: [{ type: "text", text: "Action blocked..." }] }
```

---

## 3. Policy Gate Location

| Gate                       | File                                         | Line   | Role                                                  |
| -------------------------- | -------------------------------------------- | ------ | ----------------------------------------------------- |
| `decideToolCallCapability` | `src/plugins/plugin-runtime-guard.ts`        | `~70`  | Maps tool name → capabilities (heuristic)             |
| `decidePluginActionPolicy` | `src/plugins/plugin-capability-policy.ts`    | `~36`  | Policy check on capabilities                          |
| `guardPluginActionRuntime` | `src/plugins/plugin-runtime-guard.ts`        | `~163` | Runtime guard wrapper                                 |
| **Chokepoint**             | `src/agents/agent-bundle-mcp-materialize.ts` | `~168` | `createExecute` closure calls guard before `callTool` |

---

## 4. Root Cause

### Primary: `bundle_probe` is an internal probe tool, not a real MCP tool

The tool `bundle_probe` is **infrastructure** — part of OpenClaw's own bundle MCP system to probe whether servers are reachable. It is not a user-invoked MCP tool from an external plugin server.

### Why the heuristic classifier fails

```
"bundle_probe" → no prefix matches any pattern:
  read?     ❌ (doesn't start with read/get/list/search/find/fetch/query/lookup/check/peek/...)
  write?    ❌ (doesn't start with create/update/set/add/...)
  send?     ❌
  delete?   ❌
  financial? ❌
  destructive? ❌
  → fallback ["write"] (conservative) → blocked by approval gate
```

### Why runtime tests pass but materialize test fails

The runtime tests (`agent-bundle-mcp-runtime.test.ts`) renamed the probe:

- `"bundle_probe"` → `"get_bundle_probe"` (6668a2517a)
- `"get_bundle_probe"` matches `TOOL_READ_PATTERN` → `["read"]` → **passes** guard ✅

But the materialize test (`agent-bundle-mcp-tools.materialize.test.ts`) still uses `"bundle_probe"` without prefix → pattern miss → `["write"]` → **blocked** ❌

---

## 5. Materialize write vs metadata distinction

The `bundle_probe` tool is:

- **Not a write** — it's a read-only connectivity probe
- **Not metadata generation** — it's a real MCP `tools/call` to the server
- **Internal infrastructure** — it exists only in OpenClaw's bundle MCP layer, not user-facing

The PLUGIN-RUNTIME-BLOCK-003 gate is correctly placed conceptually (at the callTool chokepoint), but it should **skip internal bundle probe tools**.

---

## 6. 수정 선택지

### 선택지 A: `bundle_probe`를 read 패턴에 추가 (권장)

**수정:** `TOOL_READ_PATTERN`에 `bundle`이나 `probe` 패턴 추가  
**장점:** 최소 변경, 직관적  
**단점:** 악의적 도구가 `bundle_` prefix 사용 시 우회 가능  
**위험도:** 🟢 낮음 — prefix가 정확히 일치하면 문제 없음  
**파일:** `src/plugins/plugin-runtime-guard.ts` 1줄

### 선택지 B: 내부 번들 도구를 정책 게이트에서 면제 (가장 정확함)

**수정:** `createExecute`에서 `.toolName.startsWith("bundle_")` 또는 내부 도구 체크 후 skip  
**장점:** 근본 원인 해결 (내부 vs 외부 분리), 확장성 좋음  
**단점:** 내부 도구 식별 로직 추가 필요  
**위험도:** 🟢 낮음  
**파일:** `src/agents/agent-bundle-mcp-materialize.ts`

### 선택지 C: capability 정보를 catalog 타임에 저장 (설계 개선)

**수정:** `McpCatalogTool`에 `capabilities` 필드 추가, catalog 빌드 시 클래스, execute 시 재계산 대신 저장값 사용  
**장점:** 정확한 분류, 확장성, 외부 MCP 도구까지 적용 가능  
**단점:** 타입 변경, catalog 구조 변경, 더 큰 변경  
**위험도:** 🟡 중간  
**파일:** types + materialize + runtime

### 선택지 D: 테스트만 수정 (응급)

**수정:** 테스트 도구명을 `"get_bundle_probe"`로 변경 (runtime 테스트처럼)  
**장점:** 1줄 변경, 테스트 통과  
**단점:** 근본 원인 방치, 추후 실제 `bundle_probe` 사용 시 실패  
**위험도:** 🔴 높음 — 근본 원인 미해결

---

## 7. Summary

| 항목                          | 값                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| 실패 테스트                   | `passes selected MCP servers into catalog materialization without recataloging on execution` |
| 실패 assertion                | `expectTextContentBlock(result.content[0], "FROM-TAVILY")`                                   |
| call path                     | `materialized.tools[0].execute` → `guardPluginActionRuntime` → `approval_required`           |
| policy gate 위치              | `src/agents/agent-bundle-mcp-materialize.ts:168` (createExecute 내 guard)                    |
| materialize가 실제 write인가? | ❌ 아니요 — `bundle_probe`는 내부 연결 프로브 (read-only)                                    |
| 수정 선택지                   | A (패턴 추가), B (내부 도구 면제), C (설계 개선), D (테스트만)                               |
| 위험도                        | 선택지 A/B: 🟢 낮음                                                                          |

---

## 8. Jinhee Recommendation

**선택지 B + A 조합 추천:**

1. **(필수)** `createExecute`에서 `tool.serverName === "bundle"` 또는 내부 번들 도구는 정책 게이트 skip
2. **(권장)** `TOOL_READ_PATTERN`에 `probe`를 read로 인식하도록 추가 (일관성)
3. **(옵션)** 테스트도 `get_bundle_probe`로 변경 (runtime 테스트와 통일)

B 그룹 수정을 위한 다음 RUN(SEMI-AUTO-RUN-018)에서 적용 가능.
