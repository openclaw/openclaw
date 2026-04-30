title: "[Feature]: Add Cursor SDK (`@cursor/sdk`) as a core agent backend"
labels: enhancement

---

### Summary

Add `@cursor/sdk` as a core agent execution backend alongside Claude CLI and Codex CLI, enabling task delegation to Cursor's local and cloud agent runtimes.

### Problem to solve

OpenClaw supports Claude CLI and Codex CLI as agent backends but has no integration with Cursor's agent runtime. Users who rely on Cursor's models (e.g. `composer-2`) or want to leverage Cursor's cloud VMs for autonomous coding tasks cannot do so through OpenClaw's unified dispatch/failover pipeline.

> The Cursor SDK entered public beta ~24 hours ago (Apr 29, 2026). This proposes first-class support while the integration surface is still fresh and small.

### Proposed solution

Follow the same integration pattern as existing CLI backends:

1. **New runner** — `src/agents/cursor-sdk-runner.ts` with `runCursorSdkAgent()` returning `EmbeddedPiRunResult`
2. **Provider detection** — `isCursorSdkProvider()` in `model-selection.ts`
3. **Config type + Zod schema** — `CursorSdkBackendConfig` at `agents.defaults.cursorSdk` with local/cloud runtime selection
4. **Auth** — `CURSOR_API_KEY` registered in `CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES`
5. **Dispatch branches** — all three execution paths (chat reply, agent command, cron)
6. **Error classification** — SDK-native `AuthenticationError`/`RateLimitError` mapped to `FailoverReason`

The Cursor SDK agent has its full built-in harness (codebase indexing, file editing, terminal, MCP servers, subagents) — same as how Claude CLI ships with its own tools. A single prompt can trigger multi-step autonomous work within the agent's sandbox.

### Alternatives considered

- **Plugin-only approach** — register Cursor SDK as a plugin rather than core. Weaker because the CLI backend pattern is well-established, and the SDK warrants the same first-class treatment as Claude/Codex for dispatch, failover, and lifecycle event parity.
- **Onboarding wizard plugin** — full interactive setup flow. Unnecessary for now — the target user already has a Cursor account and key. Env var (`CURSOR_API_KEY`) matches how power users expect it. Can be added later if adoption grows.

### Impact

- Affected: Any OpenClaw user who has a Cursor subscription and wants to use Cursor agents programmatically
- Severity: Feature gap — not a bug, but blocks a growing use case as Cursor SDK adoption rises
- Frequency: Every time a user wants to route tasks to Cursor's runtime
- Consequence: Users must bypass OpenClaw entirely to use Cursor agents, losing unified dispatch, failover, lifecycle events, and cron integration

### Evidence/examples

- Cursor SDK docs: https://cursor.com/docs/api/sdk/typescript
- Cursor SDK announcement: https://cursor.com/blog/typescript-sdk
- Cursor Cookbook (sample projects): https://github.com/cursor/cookbook
- Community discussion: https://forum.cursor.com/t/cursor-sdk-in-public-beta/159285

### Additional information

**Out of scope for initial PR:**

- Persistent sessions across messages (like Claude CLI live sessions — keeping the Agent alive between user turns)
- Injecting OpenClaw-specific tools (cron, sessions-send, etc.) into the Cursor agent context
- Full onboarding wizard plugin (env var pipeline only)
- UI changes
