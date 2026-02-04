# PR Review and Decomposition Plan

## Overview

This plan breaks down the **Agent Runtime** architecture into 4 manageable Pull Requests.
**Crucially, this plan strictly preserves the existing `Clawdbot` naming convention.** The project-wide rename to "Moltbot" found in the source branch is **excluded** from this plan to ensure a focused and safe review of the functional changes.

## Proposed Decomposition

### 1. Core Agent Runtime Abstraction

**Scope:** `src/agents/agent-runtime.ts`, `src/agents/pi-agent-runtime.ts`, `src/agents/runtime-result-types.ts`, `src/agents/sessions/*`.
**Goal:** Introduce the `AgentRuntime` interface and wrap the existing "Pi" agent logic to conform to it. This establishes the pattern using `ClawdbotConfig` without changing the active control flow.

### 2. Claude Runtime Implementation

**Scope:** `src/agents/claude-agent-sdk/**`, `src/agents/main-agent-runtime-factory.ts`, `src/agents/unified-agent-runner.ts`, `src/agents/unified-agent-runner.test.ts`.
**Goal:** Add the new runtime implementation and the factory/runner logic that manages it. This code will be "dormant" until the next PR.

### 3. Backend Wiring (The Switch)

**Scope:** `src/auto-reply/reply/agent-runner-execution.ts`, `src/auto-reply/reply/agent-runner.ts`, `src/agents/tool-event-logger.ts`.
**Goal:** Update the main application entry points to use `UnifiedAgentRunner` instead of calling `runEmbeddedPiAgent` directly. This activates the new architecture.

### 4. UI & UX Enhancements

**Scope:** `ui/src/**`.
**Goal:** Update the frontend to support new tool output formats (`tool_use` vs `toolcall`) and reasoning/thinking displays.

---

## Detailed PR Specifications

See the following files for detailed breakdowns of each proposed PR:

- `gemini-analysis/pr_1_core_abstraction.md`
- `gemini-analysis/pr_2_claude_runtime.md`
- `gemini-analysis/pr_3_backend_wiring.md`
- `gemini-analysis/pr_4_ui_changes.md`

## RFC / Design Proposal

A comprehensive design document explaining the new Agent Runtime architecture is available in:

- `gemini-analysis/rfc_agent_runtime.md`
