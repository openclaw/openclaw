# Slack Benign Tool Failure UX

## Status

active

## Origin

Requirements source: `docs/brainstorms/2026-05-22-slack-benign-tool-failure-ux-requirements.md`.

## Problem Frame

Slack progress/status rendering can make optional local context searches look like scary tool failures when the shell command simply found no matches. The first target cases are `rg` no-match exits and `find ... | xargs rg ...` no-match exits. Actual command failures must stay visible.

Plan assumption: benign no-result notices should be suppressed in Slack by default and shown only when the interpretation changes the visible answer or progress state. This follows the origin document's Slack priority requirement instead of adding a noisy default notice.

## Scope Boundaries

- Fix only the narrow exec/search outcome classification and Slack-facing progress wording needed for the requirements.
- Do not add a broad runtime-wide outcome taxonomy.
- Do not alter `niemand-b2b` prompts, TOOLS docs, or model answer generation.
- Do not hide missing paths, permission errors, command-not-found, syntax errors, timeouts, or other real failures.
- Preserve raw command output, exit status, stdout/stderr-derived aggregate output, and diagnostic details for logs and tool/result consumers.

## Requirements Trace

1. Distinguish success, benign no-result, and actual failure for exec search progress.
2. Do not show `failed` wording for no-result `rg` searches.
3. Keep Slack progress concise; suppress benign no-result progress unless it is the useful interpretation.
4. Keep actual failures visible and actionable.
5. Cover direct `rg` exit `1` no-match and `find ... | xargs rg ...` exit `123` no-match.
6. Do not downgrade missing paths, permission errors, command-not-found, syntax errors, or timeouts.
7. Preserve raw exit/output data and expose the narrow classification in diagnostics/events.
8. Keep the classifier conservative and command-pattern-specific.

## Implementation Units

### U1: Narrow exec no-result classifier

Files:

- Create `src/agents/bash-tools.exec-outcome-classification.ts`
- Create `src/agents/bash-tools.exec-outcome-classification.test.ts`
- Modify `src/infra/agent-events.ts`

Approach:

- Add a small pure classifier for completed exec outcomes, keyed by command text, exit code, timeout flag, and aggregate output.
- Return one of `success`, `benign_no_result`, or `failure`.
- Classify direct `rg` exit `1` with no error-looking output as `benign_no_result`.
- Classify `xargs`-wrapped `rg` exit `123` with no error-looking output as `benign_no_result`.
- Treat exit `0` as `success`.
- Treat timeout, shell failures, stderr/error-looking aggregate output, and unsupported commands as `failure` or unclassified.
- Extend command output event data with an optional `outcomeClassification` field and optional human status label.

Verification:

- Direct `rg` no-match exits classify as `benign_no_result`.
- `find ... | xargs rg ...` no-match exits classify as `benign_no_result`.
- Missing path, permission denied, command not found, syntax error, timeout, and unrelated exit `123` do not classify as benign.

### U2: Emit classification through command-output events

Files:

- Modify `src/agents/pi-embedded-subscribe.handlers.tools.ts`
- Modify `src/agents/pi-embedded-subscribe.handlers.tools.test.ts`
- Modify `src/auto-reply/get-reply-options.types.ts`
- Modify `src/auto-reply/reply/agent-runner-execution.ts`

Approach:

- Read the original exec command from the saved tool-start args when an exec tool ends.
- Compute the classifier using sanitized exec details so diagnostics stay redacted where they already are.
- Attach the classification and a concise `No matches found` status label to `command_output` events only for benign no-result cases.
- Keep `exitCode` and output fields unchanged.
- Forward the new fields through reply option callbacks so channel renderers can use them without re-parsing shell output.

Verification:

- Command-output events include `outcomeClassification: "benign_no_result"` for no-match cases while preserving `exitCode`.
- Secret redaction tests still pass.
- Actual failed exec events retain failed status/error behavior.

### U3: Slack progress wording

Files:

- Modify `src/plugin-sdk/channel-streaming.ts`
- Modify `src/plugin-sdk/channel-streaming.test.ts`
- Modify `extensions/slack/src/monitor/message-handler/dispatch.ts`
- Modify `extensions/slack/src/monitor/message-handler/dispatch.preview-fallback.test.ts`

Approach:

- Extend command-output progress input with the optional outcome classification and status label.
- Render `benign_no_result` as a completed/search-no-result line such as `No matches found` rather than `exit 1` or `exit 123`.
- Keep Slack's main answer prioritized; do not add a separate warning card.
- Continue rendering actual nonzero, timeout, and failed statuses as actionable progress/failure lines.

Verification:

- Slack preview/progress tests show benign no-result progress without failure wording.
- Existing error-final and streaming fallback tests remain unchanged.
- Progress rendering for a real nonzero non-benign command still includes the exit code.

## Test Plan

Run:

```bash
pnpm test src/agents/bash-tools.exec-outcome-classification.test.ts
pnpm test src/agents/pi-embedded-subscribe.handlers.tools.test.ts -t "command_output"
pnpm test src/plugin-sdk/channel-streaming.test.ts
pnpm test extensions/slack/src/monitor/message-handler/dispatch.preview-fallback.test.ts
pnpm check:changed
```

If `src/channels` or Slack hot entrypoints are broadened beyond the files above, also run:

```bash
pnpm build
```

## Risks

- Shell commands are arbitrary strings; the classifier must remain conservative to avoid downgrading real failures.
- GNU `xargs` exit `123` can mean child failure, not just no matches. Only classify it when the command visibly wraps `rg` and aggregate output is clean.
- Some useful no-result searches may still show an exit code if they do not match the narrow first-pass patterns. That is acceptable for this scope.
