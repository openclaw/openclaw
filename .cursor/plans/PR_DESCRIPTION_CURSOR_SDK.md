# Add Cursor SDK (`@cursor/sdk`) as a core agent backend

## Summary

Integrates the [Cursor SDK](https://cursor.com/blog/typescript-sdk) as a first-class task delegation backend in OpenClaw, following the same patterns as the existing Claude CLI and Codex CLI agent integrations. Users can now configure `cursor-sdk` as their preferred provider to delegate agent tasks to Cursor's local or cloud runtimes.

## Motivation

The Cursor SDK provides a TypeScript-native interface for programmatic interaction with Cursor agents, supporting both local execution (in-process, on the user's machine) and cloud execution (dedicated Cursor VMs with repo access and auto-PR creation). Adding it to OpenClaw expands the set of available agent backends and gives users access to Cursor's agent capabilities from within the OpenClaw platform.

## Changes

### Core Runtime

- **`src/agents/cursor-sdk-runner.ts`** (new): Core runner implementing `runCursorSdkAgent()` that:
  - Resolves `CURSOR_API_KEY` via the standard `resolveApiKeyForProvider` pipeline
  - Creates a local or cloud `Agent` instance based on config
  - Streams `SDKMessage` events and collects assistant text
  - Returns `EmbeddedPiRunResult` with text payloads and metadata
  - Properly disposes the agent via `Symbol.asyncDispose` in all code paths
  - Classifies errors into `FailoverError` with appropriate reason codes (auth, timeout, surface_error)

### Configuration

- **`src/config/types.agent-defaults.ts`**: Added `CursorSdkBackendConfig` type with fields for `runtime` (local/cloud), `model`, `cloud` (repos, autoCreatePR), and `local` (cwd). Added `cursorSdk?: CursorSdkBackendConfig` to `AgentDefaultsConfig`.
- **`src/config/zod-schema.agent-defaults.ts`**: Added strict Zod validation schema for the `cursorSdk` config block.

### Provider Detection & Auth

- **`src/agents/model-selection.ts`**: Added `isCursorSdkProvider()` function using `normalizeProviderId`.
- **`src/secrets/provider-env-vars.ts`**: Added `"cursor-sdk": ["CURSOR_API_KEY"]` to `CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES`, enabling API key resolution from the environment.

### Agent Dispatch

Added `cursor-sdk` dispatch branches (between the existing CLI backend branch and the embedded Pi agent fallback) in three execution paths:

- **`src/auto-reply/reply/agent-runner-execution.ts`**: Chat reply flow — includes lifecycle event emission (start/end/error) matching the CLI pattern.
- **`src/agents/command/attempt-execution.ts`**: Interactive agent command flow.
- **`src/cron/isolated-agent/run-executor.ts`** + **`run-execution.runtime.ts`**: Cron job execution flow — uses lazy dynamic import for the runner.

### Tests

- **`src/agents/cursor-sdk-runner.test.ts`** (new): 8 unit tests covering:
  - `isCursorSdkProvider` — positive match, case-insensitive normalization, negative cases
  - `runCursorSdkAgent` — FailoverError on missing API key, successful run with text extraction, local agent creation (default), cloud agent creation with config, agent disposal on error
- **`src/agents/cursor-sdk-runner.live.test.ts`** (new): Live integration test (guarded by `OPENCLAW_LIVE_CURSOR_SDK=1`) that sends a real prompt and validates the full response pipeline.

### Dependency

- **`package.json`**: Added `@cursor/sdk` (^1.0.7).

## Configuration Example

```yaml
agents:
  defaults:
    cursorSdk:
      runtime: local # or "cloud"
      model: composer-2 # default model
      local:
        cwd: /path/to/workspace
      cloud:
        repos:
          - url: https://github.com/org/repo
            startingRef: main
        autoCreatePR: true
```

Set `CURSOR_API_KEY` in your environment or store it via an auth profile with provider `cursor-sdk`.

## Test Results

```
Unit tests:  16 passed (8 tests × 2 projects)
Live test:    1 passed (real Cursor SDK call, CURSOR_SDK_LIVE_OK response)
```

## Breaking Changes

None. This is a purely additive change. Existing providers and configurations are unaffected.

## Future Work

- Plugin manifest for `cursor-sdk` provider (interactive onboarding wizard, `openclaw setup` support)
- Model catalog entry for Cursor agent models
- Session persistence for multi-turn Cursor SDK conversations
- Provider documentation page at `docs/providers/cursor-sdk.md`
