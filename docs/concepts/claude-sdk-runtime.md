---
summary: "Per-agent opt-in Claude Agent SDK runtime: credentials, native-tool bridging, and current limitations"
read_when:
  - You are opting an agent into the Claude Agent SDK runtime
  - You need to know which OpenClaw features work (or do not) under `runtime.type: "claude-sdk"`
  - You are debugging credential or tool-call behavior for a claude-sdk agent
title: "Claude SDK Runtime"
---

# Claude SDK runtime

OpenClaw ships with three agent-loop drivers today. Each agent opts into one by setting `agents.list[<agentId>].runtime.type`:

- `embedded` (default) — the legacy `runEmbeddedPiAgent()` path backed by `@mariozechner/pi-ai`.
- `acp` — delegates the session to an external Agent Client Protocol harness.
- `claude-sdk` — drives the loop through Anthropic's first-party [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

This page covers the `claude-sdk` driver. For the shared loop semantics above it (streaming, queueing, hook points), see [Agent Loop](/concepts/agent-loop).

## Opting an agent in

Set the runtime type on the agent entry in your config:

```yaml
agents:
  list:
    - id: my-agent
      runtime:
        type: claude-sdk
        claudeSdk:
          # Optional overrides — all fields here are optional.
          model: claude-sonnet-4-5-20250929
          maxTurns: 20
          credential: subscription  # "subscription" (default) or "profile"
```

Nothing else changes. The flag is strictly additive. Any agent that does not set `runtime.type` continues to use the `embedded` driver byte-for-byte identically to pre-opt-in behavior.

## Credentials

Two modes, chosen via `runtime.claudeSdk.credential`:

### `subscription` (default)

The driver leaves all Anthropic env vars unset and lets the spawned Claude Code subprocess inherit the user's `claude login` session from `~/.claude/`. Requests count against the user's Claude.ai Pro or Max subscription quota.

This is the safe, non-metered default. If you did not set `credential` explicitly, you are in this mode.

### `profile`

The driver routes credential selection through OpenClaw's existing auth-profile store (`openclaw doctor` / `openclaw auth *`). The profile's provider must be `anthropic`. Based on the stored credential type:

- OAuth profile → populates `ANTHROPIC_AUTH_TOKEN` for the SDK subprocess (still subscription-style, not metered API).
- API-key profile → populates `ANTHROPIC_API_KEY`. **This is metered per token used.** Only opt in if you deliberately want pay-as-you-go billing.

Rotation on transient failures (HTTP 401 / 429) reuses the same `markAuthProfileCooldown` bookkeeping as the embedded runtime.

## Native tool bridging

OpenClaw's native tools — `message`, `sessions.send`, `cron.add`, plus every plugin-contributed tool — use TypeBox schemas for their parameters. The Agent SDK registers custom tools through the MCP SDK, which requires Zod schemas. The claude-sdk driver bridges the two at run time via `src/agents/claude-sdk/typebox-to-zod.ts`:

1. `createOpenClawCodingTools()` produces the same policy-filtered tool inventory used by the embedded runtime.
2. Each tool's TypeBox `parameters` schema is converted to an equivalent Zod shape (covering Object, String, Number, Integer, Boolean, Array, Literal, Union, Record, Optional, Partial, Null, Any, Unknown).
3. The tools are registered on an in-process MCP server via `createSdkMcpServer()` and passed to the SDK's `mcpServers` option.
4. When the model calls a tool, the MCP handler invokes the original `AgentTool.execute()` (with its existing TypeBox validation) and translates the `AgentToolResult` content blocks back into MCP `CallToolResult` shape.

If the inventory build fails (policy resolution error, plugin registry issue, etc.), the run falls back to SDK built-in tools only and logs the failure — it does not crash. Tools whose TypeBox schema contains an unsupported constructor still register, but with a loosened parameter shape; the OpenClaw-side TypeBox validation inside `execute()` still catches mismatches.

## Hook translation

Workspace hook entries (see [Hooks](/hooks)) are loaded via `loadWorkspaceHookEntries()` and translated into SDK `HookCallbackMatcher` records. The following OpenClaw event strings map to SDK `HookEvent` values:

| OpenClaw event       | SDK event              |
| -------------------- | ---------------------- |
| `session:start`      | `SessionStart`         |
| `session:end`        | `SessionEnd`           |
| `tool:pre`           | `PreToolUse`           |
| `tool:post`          | `PostToolUse`          |
| `tool:post_failure`  | `PostToolUseFailure`   |
| `user:prompt`        | `UserPromptSubmit`     |
| `notification`       | `Notification`         |
| `stop`               | `Stop`                 |
| `subagent:start`     | `SubagentStart`        |
| `subagent:end`       | `SubagentStop`         |
| `compact:pre`        | `PreCompact`           |
| `permission:request` | `PermissionRequest`    |

Events not in the mapping are logged as a warning (they're dropped for the SDK run, not silently discarded). Handler invocation is lazy — the handler module is imported on the first fire per run.

## Session persistence

The SDK writes its primary Anthropic-shape transcript to `~/.claude/projects/<encoded-path>/<session-id>.jsonl` as usual.

In parallel, `src/agents/claude-sdk/session-mirror.ts` projects each SDK message into the legacy pi-ai JSONL shape and writes a **sidecar file** alongside OpenClaw's existing per-agent session file. The sidecar lives at `<primarySessionFile>.claude-sdk.jsonl` — for example `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl.claude-sdk.jsonl`. We use a sidecar (not the primary file) because pi-ai's `SessionManager` may open and rewrite the primary file during pre-run initialization, which would clobber any frames an in-process append stream had already written.

The sidecar's existence and content is the deterministic on-disk evidence that a turn went through the claude-sdk runtime. Tooling that wants to surface "this turn ran on claude-sdk" should check for the sidecar; tooling that reads the legacy session file is unaffected.

## Parameter coverage

The driver consumes the same `RunEmbeddedPiAgentParams` shape as the embedded runtime. Mapped fields:

- `prompt`, `sessionId`, `sessionKey`, `agentId`, `sessionFile`, `workspaceDir`, `agentDir`, `config`, `runId`, `authProfileId` — core plumbing
- `abortSignal` + `timeoutMs` — combined into a single `AbortController`
- `model`, `provider` — forwarded as SDK options
- `extraSystemPrompt` — appended to the claude_code preset via `systemPrompt: { type: "preset", preset: "claude_code", append }`
- `toolsAllow` / `disableTools` — mapped to SDK `tools` (empty array disables all built-ins)
- `thinkLevel` — mapped to SDK `maxThinkingTokens` (off→0, minimal→1024, low→2048, medium→8192, high→16384, xhigh→32768, adaptive→SDK default)
- `onAgentEvent`, `onPartialReply`, `onAssistantMessageStart` — streaming callbacks fired during message iteration

Fields that are intentionally ignored (with a run-start warning so misconfigurations surface visibly rather than silently):

- `streamParams`, `blockReplyChunking` — pi-ai-internal streaming config with no SDK equivalent
- `skillsSnapshot` — skills reach the SDK via generated sub-agent files under `.claude/agents/`
- `clientTools` — OpenResponses-specific
- `execOverrides`, `bashElevated` — plugged into OpenClaw's embedded bash tool, not the SDK's built-in
- `bootstrapContextMode`, `bootstrapContextRunKind` — pi-ai bootstrap system
- `internalEvents`, `inputProvenance` — OpenClaw diagnostic hooks
- `replyOperation` — auto-reply state
- `cleanupBundleMcpOnRunEnd` — bundled MCP lifecycle, handled above the adapter
- `fastMode` — no clean SDK equivalent today

`memoryFlushWritePath` is passed through to `createOpenClawCodingTools()` (so tools that honor it still do) even though the post-run flush semantics are handled by the calling layer.

## Known limitations

- **First-run SDK cold start is expensive.** The Claude Code subprocess does real first-launch initialization (plugin discovery, MCP handshake, sub-agent catalog). On a cold developer machine expect 1-3 minutes before the first assistant token. Warm runs are fast.
- **Broader parity is unverified.** The adapter has unit-tested plumbing and a live E2E happy-path test (`src/agents/claude-sdk/run.live.test.ts`). Real-world scenarios — auto-reply with a channel inbound, cron-scheduled runs, multi-agent orchestration — have not yet been validated. See the Phase 4 prerequisites in `plans/proud-roaming-lollipop.md` if you are considering retiring the embedded runtime.

## Related

- [Agent Loop](/concepts/agent-loop) — shared loop semantics above the runtime driver.
- [OAuth](/concepts/oauth) — how `claude login` credentials are stored.
- [Hooks](/hooks) — authoring workspace hooks.
