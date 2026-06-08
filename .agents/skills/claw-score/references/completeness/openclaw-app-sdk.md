# OpenClaw App SDK Completeness

Use this rubric when assigning category Completeness scores for the
`openclaw-app-sdk` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw exposes a supported external App SDK
for applications built outside the Gateway process. Score whether each category
delivers an app-developer workflow from connection through agent runs, sessions,
events, approvals, resources, compatibility, and operational error handling.

## Scoring Questions

For each category, ask:

- Can an external app developer complete the category workflow using public SDK APIs?
- Are the taxonomy features represented by stable client contracts rather than protocol-only fragments?
- Are setup, authentication, streaming, result handling, error behavior, and compatibility expectations documented?
- Are browser, Node, React, testing, and custom transport variants covered where the category expects them?
- Do known gaps leave major external-app capability branches missing?

## Surface-Specific Guidance

- Favor higher Completeness when the SDK hides low-level Gateway protocol details behind typed, documented, and reusable client APIs.
- Lower Completeness when a category requires users to manually construct raw Gateway frames or rely on internal package shapes.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is Quality.

## Category Scope

- Client API: SDK entrypoints, namespace layout, package split, and app/plugin boundary.
- Gateway Access: Gateway connect, URL and token config, auto gateway, custom transport, and scopes/redaction.
- Agent Conversations: agent handles, agent runs, run results, session creation, session send, and session controls.
- Events and Approvals: event stream, event envelope, replay cursors, approval callbacks, and questions.
- Resource Helpers: models, ToolSpace, artifacts, tasks, and environments.
- Compatibility: generated client, ergonomic wrappers, unsupported calls, schema alignment, and public package contract.

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.
