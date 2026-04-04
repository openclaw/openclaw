# Cron `--thread-id` Redesign Spec

## Goal

Rebuild `cron add` / `cron edit` `--thread-id` support from a clean branch with a single, explicit rule model.

This redesign should:

- keep `--thread-id` scoped to Telegram topic delivery
- make `cron add` and `cron edit` use the same validation rules
- make `cron edit` validate against the effective post-edit state, not only raw CLI input
- eliminate patch-by-patch drift between session, payload, and delivery validation
- preserve non-`--thread-id` cron behavior for other channels

## Scope

In scope:

- `src/cli/cron-cli/register.cron-add.ts`
- `src/cli/cron-cli/register.cron-edit.ts`
- `src/cli/cron-cli.test.ts`
- shared helper(s) for thread-id/session-target validation if needed

Out of scope:

- changing general delivery behavior for non-`--thread-id` edits
- changing Discord / WhatsApp / other channel semantics when `--thread-id` is absent
- changing backend cron schema or gateway transport behavior

## Domain Rule

`--thread-id` means:

> deliver this cron job to a Telegram forum topic

At the CLI layer, topic delivery is represented by composing the normalized Telegram target as:

- `delivery.to = "<chatId>:topic:<threadId>"`

This rewrite intentionally keeps that existing external target representation for cron CLI output and
does not switch the CLI patch format to a separate `delivery.threadId` field.

Therefore `--thread-id` is valid only when the final cron job is:

- a non-main session target
- an `agentTurn` payload
- a Telegram delivery
- using a valid delivery target
- not using an incompatible delivery mode/path

## Terms

### Non-main session target

A session target is non-main when it is one of:

- `isolated`
- `current`
- `session:<id>` where `<id>` is non-empty after trimming

### Inferred state

Used by `cron add`.

Because there is no existing job, omitted fields may be inferred from defaults and payload shape.

### Effective state

Used by `cron edit`.

The effective state is the job state after applying the edit patch to the existing job:

- effective session target
- effective payload kind
- effective delivery mode
- effective delivery channel
- effective delivery target

`--thread-id` validation for `cron edit` must use effective state.

## Normalization Rules

Before validation, normalize these inputs:

- `threadIdRaw = trim(opts.threadId)` when provided
- `channelRaw = trim(opts.channel)` when provided
- `toRaw = trim(opts.to)` when provided

Rules:

- provided but blank `threadIdRaw` is invalid
- provided but blank `channelRaw` is invalid in `--thread-id` mode
- provided but blank `toRaw` is invalid in `--thread-id` mode
- blank values are not treated as fallback requests
- blank values are not treated as explicit clears in `--thread-id` mode

## Add Rules

For `cron add`, `--thread-id` is valid only if:

- inferred session target is non-main
- payload kind is `agentTurn`
- normalized channel is exactly `telegram`
- normalized `to` is non-empty
- normalized thread id is numeric

For `cron add`, reject:

- `main` + `systemEvent`
- non-Telegram channel
- blank or missing `--to`
- blank or non-numeric `--thread-id`

## Edit Rules

For `cron edit`, compute:

- effective session target
- effective payload kind
- effective delivery mode
- effective channel
- effective `to`

Then validate `--thread-id` against that effective context.

### Effective session target

- use `opts.session` if explicitly provided and non-blank
- otherwise use `existing.sessionTarget`

### Effective payload kind

- `systemEvent` if the edit explicitly sets `--system-event`
- `agentTurn` if the edit explicitly sets agent-turn payload fields
- otherwise use `existing.payload.kind`

### Effective delivery channel

- if `--channel` is provided and blank: reject in `--thread-id` mode
- if `--channel` is provided and non-blank: use it
- otherwise use `existing.delivery.channel` when fallback is allowed

### Effective delivery target

- if `--to` is provided and blank: reject in `--thread-id` mode
- if `--to` is provided and non-blank: use it as the Telegram base target before appending `:topic:<id>`
- otherwise use `existing.delivery.to` only when fallback is allowed, after stripping any existing `:topic:<id>` suffix

### Effective delivery mode

- use explicit patch if provided
- otherwise use existing delivery mode

## Fallback Rules

When `--thread-id` is present in `cron edit`:

- existing target may be reused only if existing channel is Telegram
- existing target may not be reused from non-Telegram delivery
- existing target may not be reused from webhook delivery when converting to Telegram topic delivery without explicit valid Telegram target
- webhook jobs require explicit compatible mode handling
- when reusing an existing Telegram target, the CLI must replace any existing `:topic:<id>` suffix rather than append a second one

## Webhook Rules

When `--thread-id` is present:

- `--no-deliver` is invalid
- webhook delivery jobs must not silently remain webhook while receiving Telegram topic target syntax
- webhook jobs may require explicit `--announce`
- webhook jobs still require explicit valid Telegram `--to` when existing target is a webhook URL

## Error Policy

Errors should be fail-fast and explicit at CLI level.

Prefer messages like:

- `--thread-id is only supported for non-main agentTurn jobs`
- `--thread-id requires --channel telegram`
- `--thread-id requires --to`
- `--thread-id must be a non-empty numeric value`
- `--thread-id is not supported with --no-deliver`
- `--thread-id is not supported for webhook delivery jobs unless --announce is set`

Avoid:

- late backend RPC failures
- implicit fallback from incompatible existing delivery state
- silent dropping of `--thread-id`

## Proposed Helpers

Expected helper structure for the rewrite:

- `isNonMainSessionTarget(target: string | undefined): boolean`
- `normalizeThreadIdInputs(opts): { threadIdRaw, channelRaw, toRaw, ... }`
- `resolveEffectiveThreadContext(opts, existingJob?): ThreadContext`
- `validateThreadContext(ctx): void`

Possible `ThreadContext` fields:

- `threadId`
- `explicitChannel`
- `explicitTo`
- `effectiveSessionTarget`
- `effectivePayloadKind`
- `effectiveDeliveryMode`
- `effectiveDeliveryChannel`
- `effectiveDeliveryTo`
- `existingDeliveryMode`
- `existingDeliveryChannel`
- `existingDeliveryTo`

## Decision Table

Representative required outcomes:

| Case                                                             | Expected |
| ---------------------------------------------------------------- | -------- |
| add + isolated + agentTurn + telegram + valid to + valid thread  | allow    |
| add + main + systemEvent + thread-id                             | reject   |
| add + discord + thread-id                                        | reject   |
| add + telegram + blank to + thread-id                            | reject   |
| add + telegram + blank channel + thread-id                       | reject   |
| edit existing isolated agentTurn telegram + thread-id            | allow    |
| edit existing current agentTurn telegram + thread-id             | allow    |
| edit existing session:<id> agentTurn telegram + thread-id        | allow    |
| edit existing main systemEvent + thread-id                       | reject   |
| edit + explicit system-event + thread-id                         | reject   |
| edit + explicit non-Telegram channel + thread-id                 | reject   |
| edit + blank channel + thread-id                                 | reject   |
| edit + blank to + thread-id                                      | reject   |
| edit existing non-Telegram target + no explicit to + thread-id   | reject   |
| edit existing webhook + no announce + thread-id                  | reject   |
| edit existing webhook + announce + no explicit to + thread-id    | reject   |
| edit existing webhook + announce + valid telegram to + thread-id | allow    |
| edit + no-deliver + thread-id                                    | reject   |
| edit + exact + paged lookup + thread-id                          | allow    |

## Test Matrix

Minimum tests required in the rewrite:

- add success path for Telegram topic
- add invalid session/payload path
- add invalid channel path
- add blank channel path
- add blank target path
- add blank thread-id path
- edit success path with explicit Telegram target
- edit success path using existing Telegram target fallback
- edit success path for `current`
- edit success path for `session:<id>`
- edit reject for main/systemEvent
- edit reject for explicit `--system-event`
- edit reject for non-Telegram channel
- edit reject for blank channel
- edit reject for blank target
- edit reject for non-Telegram existing fallback
- edit reject for webhook without announce
- edit reject for webhook announce without explicit Telegram target
- edit allow for webhook -> announce with explicit Telegram target
- paged lookup page-2 coverage
- paged lookup stable ordering assertion
- no duplicate paged traversal when cached existing job is sufficient

## Implementation Plan

1. Create shared helper(s) for non-main session and thread-id context normalization.
2. Rebuild `cron add` validation around normalized thread-id inputs.
3. Rebuild `cron edit` validation around effective thread context.
4. Keep paged lookup logic separate from thread validation logic.
5. Rewrite/add tests from the decision table before final cleanup.
6. Run targeted cron CLI tests.

## Non-Goals For This Rewrite

- broad cleanup of all cron delivery validation
- changing non-thread-id clear semantics for generic `--channel` / `--to`
- changing backend delivery persistence behavior

## Acceptance Criteria

The rewrite is done when:

- `cron add` and `cron edit` share the same thread-id rule model
- `current` and `session:<id>` are supported where appropriate
- blank input cases fail fast
- webhook/non-Telegram fallback is explicit and safe
- paged lookup remains stable and cached
- targeted cron CLI tests pass
- no known reviewer-raised thread-id cases remain unaddressed
