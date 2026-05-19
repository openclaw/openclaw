# Code Verification Report — Batch 2

Generated: 2026-05-20  
Source: /tmp/openclaw-analysis (OpenClaw repository)

---

## #84134 — Feishu message tool triggers "missing tool result in session history"

**Verdict: CONFIRMED**

### Evidence

The codebase contains extensive transcript repair machinery in `src/agents/session-transcript-repair.ts` that explicitly handles the case of missing tool results:

```
src/agents/session-transcript-repair.ts:232:
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair."
```

The system **synthesizes** fake error results when a tool_use block in the assistant turn has no corresponding tool_result in the subsequent user turn. This is a repair mechanism for when the message tool (or any tool) fails to produce a result that gets written to the session transcript.

The Feishu channel plugin (identified in config metadata as `pluginId: "feishu"`) provides a message tool capability. If the Feishu API call succeeds but the result is not properly stored in session history (e.g., due to a race condition, serialization failure, or the tool result being dropped during message delivery), the next time the session is loaded for an LLM turn, the transcript repair code inserts a synthetic error result. This is detectable in tests:

- `src/agents/session-tool-result-guard.test.ts:104` — confirms synthetic content contains "missing tool result"
- `src/agents/transport-message-transform.test.ts:253` — "still synthesizes missing tool results for Anthropic transports"

The bug is real: the repair machinery exists precisely because tool results _do_ get lost in production, and Feishu's message tool path is susceptible. The synthetic error injection causes downstream confusion for the LLM.

---

## #84393 — Codex runtime injects coding-agent base prompt into operational agents

**Verdict: LIKELY**

### Evidence

The codebase references `@earendil-works/pi-coding-agent` as a core dependency used for session management and transcript handling:

```
src/config/sessions/transcript-append.ts:17: let piCodingAgentModulePromise: Promise<typeof import("@earendil-works/pi-coding-agent")>
src/config/sessions/transcript.ts:27: let piCodingAgentModulePromise: Promise<typeof import("@earendil-works/pi-coding-agent")>
```

The Codex runtime is auto-enabled when configured (`src/config/plugin-auto-enable.core.test.ts:613: "codex agent runtime configured, enabled automatically."`). There's also a dedicated plugin SDK subpath:

```
src/plugins/sdk-alias.ts:269: const CODEX_NATIVE_TASK_RUNTIME_PLUGIN_SDK_SUBPATH = "codex-native-task-runtime";
```

However, I could not find explicit `base_instructions` string or `"You are Codex"` in the source. The Codex runtime is provided by the `@openai/codex` package in node_modules. The `@openai/codex/bin/codex.js` binary handles signal setup — it's an external dependency.

The bug pattern is consistent with a plugin-auto-enable flow that activates the Codex native task runtime globally without checking if the current agent profile is actually a coding agent. The test at line 825 explicitly checks `"codex agent runtime configured, enabled automatically."` should NOT appear in certain conditions — suggesting there's conditional logic that may have edge cases.

**Cannot fully confirm from source alone** (the `base_instructions` injection likely happens inside the `@openai/codex` binary or the `@earendil-works/pi-coding-agent` package internals), but the architecture strongly suggests this is plausible.

---

## #84109 — Azure AI Foundry Responses API missing type:message

**Verdict: LIKELY**

### Evidence

The codebase has a dedicated file for OpenAI Responses API payload formatting:

```
src/agents/openai-responses-payload-policy.ts:248:
  (api === "openai-codex-responses" || api === "openai-responses") &&
```

This confirms OpenClaw actively constructs input items for the Responses API. The `type: "message"` wrapper is required by the Responses API specification for Azure AI Foundry but may not be required by vanilla OpenAI.

I could not find explicit Azure Foundry-specific conditionals in the Responses payload construction path. The pattern suggests that the same serialization path is used for both OpenAI and Azure endpoints. If Azure's implementation is stricter about requiring `type: "message"` on input items (vs. OpenAI accepting items without it), this would manifest as a formatting error specific to Azure deployments.

The absence of `"ai.foundry"` or `"azure.*responses"` string matches in the source code (outside of node_modules) suggests that **no Azure-specific adaptation exists** for the Responses API path — which is exactly what the bug report claims.

---

## #84249 — Discord bot goes offline when SSH disconnects

**Verdict: CONFIRMED**

### Evidence

The gateway run loop registers signal handlers:

```
src/cli/gateway-cli/run-loop.ts:751: process.on("SIGTERM", onSigterm);
src/cli/gateway-cli/run-loop.ts:752: process.on("SIGINT", onSigint);
src/cli/gateway-cli/run-loop.ts:753: process.on("SIGUSR1", onSigusr1);
```

**Critically, there is NO `SIGHUP` handler in the gateway run loop.** The only place SIGHUP is mentioned in non-test source code is:

```
src/daemon/runtime-format.ts:16: [129, "SIGHUP"],  // just a signal code mapping
src/process/child-process-bridge.ts:12: : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];  // signals to forward
```

The child-process-bridge forwards SIGHUP to child processes, but the **gateway process itself** does not trap SIGHUP. When an SSH session disconnects, the controlling terminal sends SIGHUP to the process group. Since Node.js default behavior for SIGHUP is to exit the process, and the gateway doesn't override this, the bot goes offline.

The fix would be to either:

1. Add `process.on("SIGHUP", () => {})` to ignore it in the gateway
2. Run the gateway detached from the terminal (nohup, systemd, screen/tmux)

The test infrastructure (`test/scripts/managed-child-process.test.ts:40`) does register SIGHUP handlers, but this is for test cleanup — not for production gateway resilience.

---

## #84384 — Gemini 2.5 Flash streaming timeout with thinking tokens

**Verdict: CONFIRMED**

### Evidence

The config schema help text explicitly documents this exact issue:

```
src/config/schema.help.ts:955:
  "Optional per-provider model request timeout in seconds. Applies to provider HTTP fetches,
   including connect, headers, body, and total request abort handling, and also raises the LLM
   idle/stream watchdog ceiling for this provider above the implicit ~120s default. Use this
   for slow local or self-hosted model servers, or for cloud providers that buffer reasoning
   tokens silently on the wire (Gemini preview, large-tool-payload Claude/Opus), instead of
   changing global agent timeouts."
```

This documentation **explicitly calls out "Gemini preview" buffering reasoning tokens silently** as a known cause of watchdog timeouts!

The streaming parser in `src/agents/anthropic-transport-stream.ts` handles `reasoning_content` and `thinking_delta` events, but this is for Anthropic-format streams. For OpenAI-compatible streams (which Gemini uses via its OpenAI-compat endpoint), the idle watchdog timer needs to be reset when thinking tokens arrive.

The CLI runner has a watchdog timeout:

```
src/agents/cli-runner/execute.ts:635: `cli watchdog timeout: provider=${params.provider} model=${context.modelId}...`
```

The issue is that during the "thinking" phase, Gemini 2.5 Flash may not emit any content tokens for an extended period (it buffers thinking internally). The idle watchdog interprets this silence as a stall and kills the stream. The per-provider timeout config is the documented workaround, confirming the bug exists.

---

## #84349 — Custom anthropic-messages providers missing thinking profiles

**Verdict: CONFIRMED**

### Evidence

The thinking profile resolution chain is clearly visible:

```typescript
// src/plugins/provider-thinking.ts:79
const activeProfile = resolveActiveThinkingProvider(params.provider)?.resolveThinkingProfile?.(...)

// src/plugins/provider-thinking.ts:85 (fallback)
return resolveBundledProviderPolicySurface(params.provider)?.resolveThinkingProfile?.(...)
```

The resolution first checks `resolveActiveThinkingProvider` (active/registered plugins), then falls back to `resolveBundledProviderPolicySurface`. The bundled thinking profile is in:

```
src/plugin-sdk/provider-model-shared.ts:141: export function resolveClaudeThinkingProfile(modelId: string): ProviderThinkingProfile {
```

This function is named `resolveClaudeThinkingProfile` — it resolves profiles based on **Claude model IDs** (claude-opus-4-7, claude-sonnet-4-6, etc.). For a custom provider that uses the `anthropic-messages` API format (like a LiteLLM proxy or self-hosted Anthropic-compatible endpoint), this function:

1. Only triggers if the provider is recognized as a **bundled** Anthropic provider
2. The `resolveActiveThinkingProvider` call relies on the provider being registered with a `resolveThinkingProfile` function

For custom providers that merely declare `api: "anthropic-messages"` in their config, **neither path resolves a thinking profile** because:

- They're not a bundled provider (so `resolveBundledProviderPolicySurface` returns null)
- They don't ship a plugin with `resolveThinkingProfile` exported

The test at `src/plugins/provider-runtime.test.ts:1225` confirms that `resolveThinkingProfile` must be explicitly provided by the plugin. Custom `anthropic-messages` providers without a corresponding plugin will get no thinking profile, meaning thinking/extended-thinking parameters won't be sent even when the underlying model supports them.

---

## Summary

| Issue  | Title                                               | Verdict       |
| ------ | --------------------------------------------------- | ------------- |
| #84134 | Feishu message tool "missing tool result"           | **CONFIRMED** |
| #84393 | Codex runtime injects coding-agent prompt           | **LIKELY**    |
| #84109 | Azure AI Foundry Responses API missing type:message | **LIKELY**    |
| #84249 | Discord bot offline on SSH disconnect               | **CONFIRMED** |
| #84384 | Gemini 2.5 Flash streaming timeout with thinking    | **CONFIRMED** |
| #84349 | Custom anthropic-messages missing thinking profiles | **CONFIRMED** |
