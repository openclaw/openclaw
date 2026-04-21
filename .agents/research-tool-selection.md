# How OpenClaw Selects And Exposes Tools To The Model Per Turn

Built-in tools are constructed in a single factory (`createOpenClawCodingTools` → `createOpenClawTools`) that produces a fresh array each turn; plugin and bundled-MCP tools are appended. That array is then run through a multi-stage filter pipeline (owner, profile, agent/global, group, sandbox, subagent) and finally through provider-plugin schema normalization before it is handed to the inference call in `pi-embedded-runner/run/attempt.ts`.

## 1. Tool registration — where tools come from

**Built-in tools (per-turn factories).** Core tools are not a mutable global registry. `createOpenClawTools` assembles them on every invocation with a hand-written array of `create*Tool` calls — canvas, nodes, cron, message, tts, image/video/music, gateway, agents_list, sessions_*, subagents, session_status, web_search/web_fetch, plus image/pdf (`src/agents/openclaw-tools.ts:230-305`). `createOpenClawCodingTools` then layers in the pi-coding-agent `codingTools` (read/write/edit), an `exec` + `process` pair, channel-provided agent tools, and the OpenClaw set (`src/agents/pi-tools.ts:533-615`).

**Plugin tools.** Plugins register via a host-supplied `registerTool(record, tool, { name?, names?, optional? })` callback that pushes a factory entry `{ pluginId, factory, names, optional, source, rootDir }` onto `registry.tools` (`src/plugins/registry.ts:200-226`). The factory accepts an `OpenClawPluginToolContext` and returns one or many `AnyAgentTool`s. At turn time, `resolvePluginTools` walks the active registry, invokes each factory, attaches `{ pluginId, optional }` meta via a WeakMap (`pluginToolMeta`), and rejects name collisions with core tools (`src/plugins/tools.ts:105-184`). Optional plugin tools are only emitted if the caller's `toolAllowlist` includes the tool name, the plugin id, or `group:plugins` (`src/plugins/tools.ts:38-55`).

**MCP servers.** Bundled and user-configured MCP servers are materialized per-session as `BundleMcpToolRuntime` via `materializeBundleMcpToolsForRun` (`src/agents/pi-bundle-mcp-tools.ts:17-20`, `src/agents/pi-embedded-runner/run/attempt.ts:654-662`). Connections use `@modelcontextprotocol/sdk` Stdio/SSE/StreamableHTTP transports (`src/agents/mcp-transport.ts:2-117`) and their tool lists are wrapped as `AnyAgentTool`s passed reserved-name sets so they cannot shadow core/plugin/client tools. There is also an inverse bridge in `src/mcp/plugin-tools-serve.ts:22-51` that re-exports OpenClaw plugin tools as an MCP server so external ACP hosts can call them.

## 2. Tool catalog assembly per turn

The concrete assembly for a turn lives in `pi-embedded-runner/run/attempt.ts`:

1. Build `allTools = createOpenClawCodingTools(...)` and apply the optional explicit `toolsAllow` filter (`attempt.ts:476-543`).
2. Normalize provider-specific schemas via plugin hook → `toolsRaw` becomes `tools` (`attempt.ts:635-644`).
3. If tools are enabled, create or reuse a session-scoped MCP runtime and materialize MCP tools with reserved names containing the already-chosen tool/client-tool names (`attempt.ts:646-662`). LSP bundle tools follow, reserving MCP names too (`attempt.ts:663-673`).
4. Run bundled (MCP+LSP) tools through `applyFinalEffectiveToolPolicy` which is the authoritative filter pipeline (`attempt.ts:674-694`; `pi-embedded-runner/effective-tool-policy.ts:85-178`).
5. `effectiveTools = [...tools, ...filteredBundledTools]` — this is literally what goes to the provider (`attempt.ts:695`).

So it is *not* "all registered tools always." The catalog depends on `sessionKey`, `agentId`, `modelProvider`/`modelId`, sandbox context, sender identity/owner, group context, and profile config.

## 3. Sandbox / permission gating

`DEFAULT_TOOL_ALLOW` and `DEFAULT_TOOL_DENY` exactly match the README list: allow `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `image`, all `sessions_*`, `subagents`, `session_status`; deny `browser`, `canvas`, `nodes`, `cron`, `gateway`, plus every registered channel id (`src/agents/sandbox/constants.ts:13-38`).

`resolveSandboxToolPolicyForAgent` layers agent-scoped over global `tools.sandbox.tools.{allow,alsoAllow,deny}` and preserves the convention that `allow: []` means "allow all"; a provided `allow` drops the default deny list (filtered for explicit re-allows), and `image` is auto-injected unless explicitly denied (`src/agents/sandbox/tool-policy.ts:158-262`).

Matching is glob-based with `classifyToolAgainstSandboxToolPolicy` using `compileGlobPatterns` and `expandToolGroups` (`src/agents/sandbox/tool-policy.ts:180-209`). The resolved policy is plugged into the pipeline as a step labeled `"sandbox tools.allow"` alongside profile/provider/global/agent/group/subagent steps (`src/agents/pi-tools.ts:653-675`, `effective-tool-policy.ts:154-172`). Owner-only tools are filtered separately via `applyOwnerOnlyToolPolicy`, which reads per-tool `ownerOnly` metadata and drops tools when `senderIsOwner !== true` (`pi-tools.ts:651-652`).

Note the defense-in-depth: `applyFinalEffectiveToolPolicy` re-checks `groupId` against session-derived group ids and drops caller-supplied values that do not match, to prevent model-controlled input from widening bundled-tool availability (`effective-tool-policy.ts:59-83`).

## 4. Schema shaping per provider

Two layers adapt schemas:

**Core normalization** (`src/agents/pi-tools-parameter-schema.ts`, called from `pi-tools.ts:679-685` via `normalizeToolParameters`) flattens top-level `anyOf`/`oneOf`/`allOf`, extracts enum values from union/`const`/`oneOf` shapes (`pi-tools-parameter-schema.ts:13-72`), strips Gemini-incompatible keywords through `cleanSchemaForGemini`, and respects provider compat hints from `resolveUnsupportedToolSchemaKeywords`. This is why AGENTS.md recommends flat string-enum helpers over `Type.Union([Type.Literal(...)])`.

**OpenAI strict mode** (`src/agents/openai-tool-schema.ts:11-80`) walks the tree, forces `required: []` on empty-property objects, and rejects any residual `anyOf`/`oneOf`/`allOf` or array-`type` as incompatible.

**Provider-plugin normalization** (`src/plugins/provider-runtime.ts:437-455`) delegates to the active provider plugin's `normalizeToolSchemas`/`inspectToolSchemas` hooks, invoked just before the MCP/LSP bundle step (`attempt.ts:635-644`) and re-inspected for diagnostics after the catalog is finalized (`attempt.ts:700-709`). This is the seam provider plugins use to shape tools for their wire format without core knowing provider families.

## 5. Skills vs tools vs MCP

Skills are **not** first-class tools. `resolveSkillsPromptForRun` builds a text section (`src/agents/skills/workspace.ts:814`) that is inserted into the system prompt by `buildSkillsSection` (`src/agents/system-prompt.ts:156-157, 608-646`). The model learns about skills by reading prose; it calls them by invoking the `read`/`exec` tools against the skill folder. Confirmation: when `toolsAllow` is set, the runner explicitly strips the skills catalog from the prompt (`attempt.ts:811-813`).

MCP tools *are* first-class — they appear in the same `effectiveTools` array as core tools (see section 2). The plugin↔MCP direction goes both ways: plugins can expose tools as MCP via `createPluginToolsMcpServer` (`src/mcp/plugin-tools-serve.ts:29-51`).

## 6. Tool-result handling (bridge to context)

Tool results come back through `subscribeEmbeddedPiSession`, which wires `onToolResult`/`shouldEmitToolResult`/`toolResultFormat` callbacks (`attempt.ts:1644-1674`). Handlers in `pi-embedded-subscribe.handlers.tools.ts:1-41` sanitize, extract media artifacts, detect errors/timeouts, and emit `AgentItemEvent`/`AgentApprovalEvent`/`AgentPatchSummaryEvent`. A `ToolResultContextGuard` (`attempt.ts:1129, 938`) plus `flushPendingToolResultsAfterIdle` and `truncateOversizedToolResultsInSessionManager` (`attempt.ts:1554, 172`) control how tool results are folded back into the transcript for the next turn.

## 7. Activation layer

`/activation mention|always` lives in `src/auto-reply/group-activation.ts:3-37` and only controls whether an inbound group message triggers an agent turn at all. It does not gate tools; once the agent runs, tool selection follows sections 1–4.

## Open questions I could not answer from code alone

- Exact precedence ordering when sandbox policy, subagent policy, and group policy disagree on the same tool (I saw pipeline steps but did not trace a conflict resolution test).
- Whether MCP tools honor the same `ownerOnly` metadata path as core/plugin tools (the `WeakMap` path for plugin meta is clear, MCP path was not traced end-to-end).
- How `params.toolsAllow` is populated at the top of `attempt.ts:538-542` — upstream callers were not traced.
- Whether channel-provided agent tools (`listChannelAgentTools` at `pi-tools.ts:563`) participate in the sandbox deny-list via `CHANNEL_IDS` or by individual tool names.
- Whether `clientTools` (ACP client-side tools reserved in `attempt.ts:659, 669`) ever pass through `applyFinalEffectiveToolPolicy` or bypass it entirely.
