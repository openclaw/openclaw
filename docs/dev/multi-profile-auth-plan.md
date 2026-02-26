# Multi-Profile Provider Auth Implementation Plan

Status: draft approved for implementation
Owner: dev-openclaw
Scope: additive, backward-compatible support for multiple auth profiles per provider/account

## Goals

1. Run the same model alias (for example `codex-default`) through different accounts concurrently.
2. Resolve credentials with deterministic precedence:
   - request override
   - session override/default
   - agent/provider config default
   - legacy implicit default
3. Keep behavior unchanged for existing installations that do not use profiles.
4. Keep architecture channel-agnostic (no Slack-specific logic in core routing).

## Non-Goals

- No mandatory config migration for existing users.
- No breaking CLI changes to existing auth/model commands.
- No global mutable "active profile" singleton.

## Key Design Decisions

### 1) Provider-scoped profile namespace

Profiles are keyed by `(provider, profileId)`.

- `work` for `openai-codex` is independent from `work` for `google-gla`.
- Cross-provider profile bundles are explicitly out of scope for this iteration.

### 2) Profile selection precedence

Single resolver function used everywhere:

1. explicit request `profileId`
2. session-level provider profile override/default
3. agent-level provider default profile (from config)
4. provider-level default profile (from config)
5. legacy implicit default profile/token

### 3) Sticky profile via agent config

`gpod` is treated as a normal agent.

- Agent creation should inherit profile defaults from agent config.
- This makes profile sticky without channel-specific branching.
- Slack, CLI, and other channels all consume the same core session creation behavior.

### 4) UX parity with model commands

Add in-session profile controls parallel to `/model` and `/models`:

- `/profiles` → list profiles, indicate active session override and inherited defaults
- `/profile <id> [--provider <provider>]` → set session override
- `/profile clear [--provider <provider>]` → remove session override and fall back

## Backward Compatibility Strategy

- If no profile is specified, existing behavior remains unchanged.
- Existing stored provider credentials are treated as implicit `default` profile.
- New config fields are optional.
- Legacy config should validate and run without modification.
- Migration is logical/non-destructive until an explicit write in new format.

## Proposed Config Shape (additive)

```yaml
providers:
  openai-codex:
    defaultProfileId: work # optional

agents:
  gpod:
    profiles:
      openai-codex:
        defaultProfileId: work # optional
      google-gla:
        defaultProfileId: personal-2 # optional
```

Notes:

- Session-level overrides are runtime state, not required in static config.
- Request payload may pass `profileId` to override all defaults.

## CLI/API Surface Changes (additive)

Auth management:

- `models auth login --provider <provider> --profile-id <id>`
- profile-aware list/show/logout equivalents

Session/runtime:

- request payload accepts `profileId`
- session state supports provider-specific profile overrides
- session creation inherits agent/provider defaults automatically

## Work Breakdown

### Phase 1 — Discovery + file map

- Trace current auth storage and lookup paths.
- Trace model/provider/session context flow.
- Identify session-create inheritance hook.
- Identify schema and migration touchpoints.

Deliverable: file touch map and resolver insertion plan.

### Phase 2 — Data model + resolver

- Introduce profile-aware credential lookups.
- Implement centralized profile resolver with precedence above.
- Add unit tests for precedence and fallback behavior.

### Phase 3 — CLI and runtime plumbing

- Add `--profile-id` support to auth commands.
- Thread `profileId` through request/session execution paths.
- Add session-level runtime override support.

### Phase 4 — Agent config defaults + create flow

- Add agent-level provider profile defaults in config schema.
- Ensure session creation inherits these defaults.
- Ensure channel adapters do not need special handling.

### Phase 5 — Chat UX commands

- Implement `/profiles`, `/profile`, `/profile clear`.
- Return clear status showing explicit vs inherited profile source.

### Phase 6 — Compatibility + migration hardening

- Validate old configs unchanged.
- Verify legacy single-account auth still works.
- Verify no destructive migration/write on read.

### Phase 7 — Docs + rollout artifacts

- Docs for concept, config, and command usage.
- Upgrade notes emphasizing no required migration.
- Live-instance patch script for existing installs.

## Test Matrix

### Compatibility

- Existing config without profile fields starts and routes unchanged.
- Existing auth tokens function without any profile arguments.

### Functional

- Same model alias with two profile IDs routes to distinct credentials.
- Per-request override wins over session and config defaults.
- Session override wins over agent/provider defaults.

### Concurrency

- Parallel requests/sessions with different profiles do not cross-contaminate.
- Sub-agent/session-spawn flows preserve intended profile context.

### Cross-provider independence

- `work@openai-codex` + `personal-2@google-gla` operate simultaneously.

### UX

- `/profiles` reflects available and currently effective profile source.
- `/profile` set/clear updates only target session context.

## Risks & Mitigations

- **Risk:** hidden global state causing profile bleed.
  - **Mitigation:** resolver requires explicit request/session context input; no globals.
- **Risk:** accidental breakage for legacy installs.
  - **Mitigation:** dedicated compatibility test suite and implicit default fallback.
- **Risk:** ambiguous active profile UX.
  - **Mitigation:** show effective profile + source (request/session/agent/provider/legacy).

## Acceptance Criteria

- Existing installations continue to work unchanged without profile config.
- Same model alias can be used concurrently through different accounts.
- Agent config can set sticky provider defaults inherited by new sessions.
- In-session `/profile` and `/profiles` commands work as model-command parallels.
- No Slack-specific implementation branch is needed for profile stickiness.
