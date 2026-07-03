# Proposal: Codex auth-profile fallback on usage-limit errors

Status: draft
Related issue: https://github.com/openclaw/openclaw/issues/99668

## Problem

OpenClaw can have multiple configured OpenAI OAuth auth profiles. When a Codex-backed request fails because the selected profile has reached its subscription usage limit, the runtime currently ends the run with an error that tells the user to use another Codex account or switch provider/model.

In the observed case, another compatible OpenAI auth profile was already configured, but OpenClaw did not retry the same request with that profile. The selected session had an auto-selected auth profile override, not an explicit user-locked profile.

## Goals

- Retry with another compatible OpenAI auth profile when the selected profile hits a profile-scoped Codex usage limit.
- Preserve explicit user intent when a session is locked to a specific auth profile.
- Avoid retry loops against an exhausted profile until its reset/cooldown expires.
- Record the fallback decision in session/trajectory metadata without exposing tokens or credentials.

## Non-goals

- Do not change configured auth profiles or remove user override capabilities.
- Do not silently move sessions that explicitly requested a specific auth profile.
- Do not treat every provider error as profile-scoped. This proposal is for clearly classified usage-limit/cooldown errors.

## Proposed behavior

When a Codex request fails with a classified subscription usage-limit error:

1. Classify the failure as profile-scoped and attach the reset time when the backend provides one.
2. If the current auth profile was selected automatically, mark it unavailable until reset for compatible Codex/OpenAI model attempts.
3. Select another compatible OpenAI auth profile for the same provider/model request.
4. Retry the request once per available compatible profile before falling back to model/provider fallback.
5. If the session has `authProfileOverrideSource: user`, keep the current behavior and fail clearly instead of moving the session.

## Implementation sketch

- Extend the Codex/OpenAI usage-limit classifier to return a profile-scoped cooldown result.
- Feed that result into the auth-profile selection layer before model/provider fallback is attempted.
- Track cooldown by auth profile id and provider/model compatibility, not by token value.
- When a fallback profile is selected, persist enough metadata for later runs to continue on the working profile when appropriate.
- Emit a trace event such as `auth_profile.fallback` with profile ids only, never credentials.

## Session metadata

Suggested metadata fields:

- `authProfileOverride`: selected profile id for the run/session.
- `authProfileOverrideSource`: keep `user` for explicit locks and `auto` for runtime selection.
- `authProfileFallbackFrom`: previous profile id when a fallback was selected.
- `authProfileFallbackReason`: `codex_usage_limit` or equivalent stable reason.
- `authProfileCooldownUntil`: parsed reset timestamp when available.

## Acceptance criteria

- With two configured OpenAI OAuth profiles, a Codex subscription usage-limit error on an auto-selected profile causes a retry on another compatible profile.
- User-locked auth profile sessions are not silently moved.
- The exhausted profile is not retried until reset/cooldown expires.
- If no alternate profile is available, the existing error remains clear and actionable.
- Logs and traces do not include tokens, cookies, Authorization headers, or raw credential payloads.

## Test plan

- Unit-test classifier behavior for Codex subscription usage-limit messages with and without reset times.
- Unit-test auth-profile selection when one profile is cooled down and another compatible profile exists.
- Unit-test that `authProfileOverrideSource: user` prevents automatic profile fallback.
- Integration-test a simulated run where the first profile returns a usage-limit error and the second profile succeeds.
- Regression-test model/provider fallback order so profile fallback does not mask unrelated provider errors.
