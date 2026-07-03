# Proposal: Codex auth-profile fallback on usage-limit errors

Status: draft
Related issue: https://github.com/openclaw/openclaw/issues/99684

## Problem

OpenClaw can have multiple configured OpenAI OAuth auth profiles. When a Codex-backed request fails because the selected profile has reached its subscription usage limit, the runtime currently ends the run with an error that tells the user to use another Codex account or switch provider/model.

In the observed behavior, another compatible OpenAI auth profile was already configured, but OpenClaw did not retry the same request with that profile. The selected session used an automatically selected auth profile rather than an explicit user-locked profile.

## Goals

- Retry with another compatible OpenAI auth profile when the selected profile hits a profile-scoped Codex usage limit.
- Preserve explicit user intent when a session is locked to a specific auth profile.
- Avoid retry loops against an exhausted profile until its reset/cooldown expires.
- Record the fallback decision in session/trajectory metadata without exposing tokens, cookies, Authorization headers, or private profile identifiers.

## Non-goals

- Do not remove configured auth profiles.
- Do not disable user override capabilities.
- Do not silently move sessions that explicitly requested a specific auth profile.
- Do not treat every provider error as profile-scoped. This proposal targets clearly classified usage-limit/cooldown errors.

## Proposed behavior

When a Codex request fails with a classified subscription usage-limit error:

1. Classify the failure as profile-scoped and attach the reset time when the backend provides one.
2. If the current auth profile was selected automatically, mark it unavailable until reset for compatible Codex/OpenAI attempts.
3. Select another compatible OpenAI auth profile for the same provider/model request.
4. Retry the request once per available compatible profile before falling back to model/provider fallback.
5. If the session has an explicit user-locked auth profile, keep the current behavior and fail clearly instead of moving the session.

## Metadata

Suggested metadata should use stable internal ids only and must avoid raw credentials or private account labels:

- selected auth profile id for the run/session;
- auth profile selection source, for example `user` or `auto`;
- fallback source profile id when a fallback was selected;
- fallback reason, for example `codex_usage_limit`;
- parsed cooldown/reset timestamp when available.

## Acceptance criteria

- With multiple compatible OpenAI OAuth profiles, a Codex subscription usage-limit error on an auto-selected profile causes a retry on another compatible profile.
- User-locked auth profile sessions are not silently moved.
- The exhausted profile is not retried until reset/cooldown expires.
- If no alternate profile is available, the existing error remains clear and actionable.
- Logs and traces do not include tokens, cookies, Authorization headers, email addresses, or raw credential payloads.

## Test plan

- Unit-test classifier behavior for Codex subscription usage-limit messages with and without reset times.
- Unit-test auth-profile selection when one profile is cooled down and another compatible profile exists.
- Unit-test that explicit user-locked auth profile selection prevents automatic profile fallback.
- Integration-test a simulated run where the first compatible profile returns a usage-limit error and the second compatible profile succeeds.
- Regression-test model/provider fallback order so profile fallback does not mask unrelated provider errors.
