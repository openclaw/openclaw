# RFC: Multi-Runtime Agent Architecture

## 1. Problem Statement

The current `Clawdbot` architecture was tightly coupled to the `Pi` agent system (`runEmbeddedPiAgent`). To support advanced capabilities from other providers—specifically the **Claude Code SDK** (CCSDK)—we needed a way to:

1.  Run different agent implementations (Runtimes) based on configuration.
2.  Failover gracefully between them (e.g., if Claude fails, try Pi).
3.  Unify the input parameters and output results so the rest of the application (Auto-Reply, UI) doesn't need to know which runtime executed the request.

## 2. Proposed Architecture

### 2.1. Core Abstraction: `AgentRuntime`

We introduce a standard interface `AgentRuntime` that all backends must implement:

```typescript
interface AgentRuntime {
  readonly kind: "pi" | "ccsdk";
  run(params: AgentRuntimeRunParams): Promise<AgentRuntimeResult>;
}
```

- **Inputs:** Normalized session, prompt, tool definitions, and callbacks for streaming.
- **Outputs:** Standardized payload (text, tool calls, metadata).

### 2.2. The Unified Runner

The `UnifiedAgentRunner` serves as the entry point. It implements a **"Runtime-Outer, Model-Inner"** failover strategy:

1.  **Resolve Runtime Chain:** E.g., `['ccsdk', 'pi']`.
2.  **Iterate Runtimes:** Try to instantiate the first runtime.
3.  **Iterate Models:** Within that runtime, try the configured models (and fallbacks).
4.  **Error Handling:** If all models in a runtime fail, proceed to the next runtime.

This ensures robust availability. If the Claude API is down, the system transparently degrades to the Pi agent.

### 2.3. Runtime Implementations

- **PiRuntime:** A lightweight wrapper around the legacy `runEmbeddedPiAgent` function.
- **CcSdkRuntime:** A new implementation that bridges our `AgentRuntime` interface to the `@anthropic-ai/claude-agent-sdk`. It handles:
  - Converting Clawdbot Tools -> Claude Tools.
  - Converting Claude Events -> Clawdbot Streaming Callbacks.
  - Session History management (adapting Clawdbot's file-based history to what CCSDK expects).

### 2.4. Factory Pattern

A `MainAgentRuntimeFactory` determines which runtime to use based on the `clawdbot.json` configuration (`agents.defaults.runtime` or per-agent overrides). It uses dynamic imports for the CCSDK to prevent bloating the startup time for users who only use Pi.

## 3. Forward-Looking Concerns & Alternatives

### 3.1. Tool Format Standardization

**Current Approach:** We rely on the UI (`tool-cards.ts`) to handle different JSON structures (`tool_use` vs `toolcall`).
**Alternative:** We could normalize all tool outputs _within_ the Runtime before returning them.
**Decision:** We deferred normalization to the UI for now to minimize risk of breaking the legacy Pi format, but future work should standardize this in the `AgentRuntimeResult` to simplify the frontend.

### 3.2. Session History Format

**Current Approach:** CCSDK and Pi use different history formats. We built adapters (`SessionAdapter`) but they still write to separate files or structures in some cases.
**Risk:** Switching runtimes mid-conversation might result in context loss if the history isn't perfectly portable.
**Future Work:** A unified, database-backed session store (SQLite/LanceDB) that both runtimes read/write to would solve this permanently.

### 3.3. Streaming Parity

**Issue:** Claude supports "Reasoning" (Chain of Thought) streams. Pi does not (or does it differently).
**Solution:** We added `onReasoningStream` callbacks to the interface. The UI ignores this if not present. This allows feature disparity without breakage.

## 4. Conclusion

This architecture allows `Clawdbot` to evolve from a single-model wrapper to a multi-agent platform. The separation of concerns (Runner vs. Runtime vs. Implementation) makes it easier to add future providers (e.g., OpenAI Assistants API) by simply adding a new `AgentRuntime` implementation.
