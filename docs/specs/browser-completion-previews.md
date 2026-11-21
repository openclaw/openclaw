---
title: "Browser completion preview proposal"
summary: "Proposed consent boundary and delivery contract for optional assistant answer previews in browser notifications."
read_when:
  - Evaluating response text in browser Agent finished notifications
  - Designing Web Push detail preferences or their upgrade behavior
---

# Browser completion preview proposal

**Status: proposed, not implemented.** This asks maintainers to approve a narrow
change to the [notification privacy policy](/web/notifications). The current
policy excludes message excerpts even at **Detailed**. This proposal does not
enable previews, change stored preferences, or describe an available setting.

## Problem and existing work

Browser **Agent finished** alerts identify neither the conversation nor its
answer on the inspected main revision, `a948e56619a02531cd997674b6db928d9e95a99e`.
With an agent named `main`, a non-private alert has the title
`OpenClaw agent finished` and body `main: An agent completed its response.`

[Issue #143946](https://github.com/openclaw/openclaw/issues/143946) requests
conversation attribution within the existing labels-only policy.
[PR #144862](https://github.com/openclaw/openclaw/pull/144862) implements explicit
session labels and was still open when inspected on October 1, 2026. It is not
part of this checkout's main. Reuse that work if it lands; otherwise coordinate
with its author before implementing session labels. This proposal neither
duplicates that patch nor claims to close the attribution issue.

[PR #129348](https://github.com/openclaw/openclaw/pull/129348), which established
device/profile-bound notifications and preferences, is merged. Its privacy and
authorization boundaries remain the starting point. Excerpts are a product
policy change, not a repair to the documented meaning of Detailed.

## Proposed behavior

Only successful, visible, final assistant answers qualify for completion alerts.
Apply that eligibility rule at every detail level, independently of whether a
recipient permits an excerpt.

| Effective preference         | Notification content                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Private                      | Existing generic completion title and body; no conversation label or answer text.                    |
| Names only                   | Existing permitted sanitized labels; no answer text.                                                 |
| Detailed without new consent | Existing labels-only behavior, with an explicit settings explanation.                                |
| Detailed with new consent    | An authorized explicit session label when available, plus a bounded plain-text final-answer preview. |

For consenting Detailed recipients, retain the existing title unless an explicit
session label is available; then use `OpenClaw agent finished — Fitness coach`.
Use the preview as the body, for example `Today's session: upper body. Start
with…`. Keep the existing source/device-label behavior. Private gains no new
identifying content. These examples illustrate the proposed display, not a
change to routing or labels permitted in other categories.

Resolve only the explicit `entry.label` of one authoritative session target,
after recipient admission. Use the existing 80-unit notification-label bound
and sanitizer. Do not promote raw session keys, payload titles, generated
titles, subjects, prompts, or answer text into labels. Ambiguous session scope,
missing metadata, or an unusable label retains the existing agent/generic
fallback; it must not trigger a transcript lookup.

If an eligible answer has no usable preview after normalization, retain the
existing identified/generic completion body. A missing terminal message is
different: the current producer uses it for silent and empty tool-only turns,
so suppress that completion alert. A visible canvas-only assistant answer can
use generic fallback without extracting the canvas payload. Failed, aborted,
yielded, hidden, diagnostic, reasoning-only, tool-only, and transcript-mirror
events do not become successful completion alerts.

Clicking continues to open the same authenticated conversation on its owning
Gateway. The label and preview must never supply the routing identity.

## Consent and stored Detailed preferences

Do not reinterpret existing `detailLevel: "detailed"` records as permission to
publish answer text. The previous promise explicitly excluded it. Category
enablement, browser notification permission, and consent to labels do not imply
consent to answer previews.

Propose an optional, versioned consent marker in the existing account and device
preference objects, such as `answerPreviewConsentVersion: 1`. Missing, invalid,
or unknown versions mean no answer preview. The field name is a proposed wire
contract, not an existing API. No new table, sidecar, transcript copy, or
subscription is needed. The existing preference normalization and worker-backed
storage owners must own this field too.

Resolve detail and consent together from the same preference layer:

- A device with no detail override inherits the account's detail and consent.
- A device with its own detail override uses only that device's consent. An old
  Detailed device override remains labels-only even when the account opts in.
- Private and Names only never use a consent marker to enable excerpts.
- Changing a category, quiet hours, agent filter, device label, or subscription
  must not create consent. Normal preference saves preserve acknowledged consent
  without upgrading an unacknowledged Detailed record.
- Selecting Private or Names only clears the marker at that layer. Returning to
  Detailed requires the new disclosure and explicit selection again.

The upgraded UI must show the disclosure before a new Detailed selection writes
the detail and consent together through the existing serialized preference
update. For an existing Detailed record, show **Answer previews are off** and an
explicit **Enable answer previews** action; opening Settings or saving an
unrelated preference does not opt in. Account-level disclosure must explain that
the choice reaches devices inheriting account defaults. Device overrides remain
independent.

This follows the existing opt-in category/default pattern and preserves stored
choices rather than resetting subscriptions. It proposes a new consent contract;
there is no existing Web Push answer-preview consent migration to reuse.
No startup or Doctor rewrite should manufacture the marker. If implementation
requires a data migration, use the owning migration workflow and its
[storage review checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes).

An older client saving a full object without the marker may disable previews;
it must never enable them. A rolled-back Gateway continues labels-only delivery.
Candidate implementation must prove old stored records, old-client writes, and
downgrade/reopen behavior using isolated preferences, not a production database.

## Delivery owner and extraction

Keep one pipeline:

1. `server-chat.ts` emits the terminal `chat` event.
2. `createGatewayConnectionState` feeds broadcasts to
   `createEventWebPushDelivery` in `src/gateway/event-web-push.ts`.
3. `withCurrentWebPushAuthority` prepares current subscription, device, profile,
   preference, and session facts; the event owner applies recipient visibility.
4. The existing Web Push sender encrypts each permitted payload.
5. `ui/public/sw.js` passes its fields to `registration.showNotification` and
   handles click-through navigation.

Build display content inside the admitted recipient loop, after resolving that
recipient's effective detail and consent. Reuse prepared current session facts
from `authority.sessions`; do not introduce synchronous database reads or an
await between the final authority check and provider start. Group only completed
recipient-specific title/body pairs. A Detailed target must never cause Private,
Names only, legacy Detailed, or denied targets to receive its excerpt.

Use `resolveRawAssistantAnswerText` from `src/shared/assistant-answer-text.ts`
for canonical final-answer selection and assistant-visible text sanitization.
Apply the canonical display-visibility rules and
`stripSuppressedControlReplyToken` before notification formatting. Use the
existing transcript-only and message-tool-mirror predicates; reject raw errors
before any projector can turn them into a friendly display message. Do not
concatenate arbitrary `message.text`, content blocks, reasoning, tool arguments,
tool results, diagnostics, or error fields. Do not search older transcript rows
when the final event has no usable answer.

The implementation must account for `emitChatTerminal` sending
`state: "final", message: undefined` after suppressing `NO_REPLY` and similar
controls. That is an intentional no-alert outcome, not a text fallback. Add
producer-to-delivery coverage, not just a helper test fed a raw `NO_REPLY` string.

Normalize the extracted answer to one readable line with the canonical
`flattenMarkdownToPlainText` helper, which drops fenced code and retains link
labels instead of Markdown destinations. Apply the existing notification display
safety/redaction policy before truncation. Keep raw markup, line/control
characters, malformed surrogates, and unsafe display controls out of the final
payload. Sanitization cannot guarantee that ordinary answer text contains no
private information; consent remains necessary.

Use a hard **240 UTF-16 code-unit** body limit, including any trailing ellipsis.
This matches the existing session-preview default in
`src/gateway/session-display-projection.ts` and allows a short message-sized
excerpt. Use `findGraphemeChunkEnd` with `allowPartial: false` so truncation never
splits a surviving Unicode grapheme, surrogate pair, or combining sequence. If
no whole grapheme fits, use the generic fallback. Apply the bound after
normalization and redaction so truncation cannot expose a partial secret.

Preserve device/profile binding, live role and scope checks, session visibility,
category overrides, quiet hours, agent filters, run-derived tags, hashed topics,
TTL, and `renotify: false`. Reuse `buildControlUiSessionPath` and
`resolveControlUiWebPushUrl`. Do not change deduplication or the service worker's
navigation policy. Keep excerpts ephemeral within delivery: no logs, telemetry,
deduplication records, preference records, or new persisted notification history.
The browser/OS notification center may retain displayed text; Gateway preference
changes cannot promise to recall an already delivered preview.

## Proposed settings and documentation copy

The implementation should replace the ambiguous settings hint with:

> Private hides conversation names and answers. Names only includes permitted
> labels. Detailed can show part of a completed assistant answer on your lock
> screen after you enable answer previews.

The consent action should disclose:

> Enable answer previews? Completed answers may contain private information.
> Anyone who can see notifications on this device may see the preview.

Account defaults also need: **This applies to browsers and apps using your
account detail level.** Legacy Detailed needs: **Your existing Detailed setting
shows names only. Enable answer previews to include response text.**

Update canonical English settings copy and `/web/notifications` with the
implemented scope and upgrade behavior together. Preserve the explicit exclusion
of excerpts for approval, question, failure, and human-mention notifications.
Do not advertise this proposal as shipped in the current notification guide.

## Required implementation evidence

These are acceptance criteria, not tests executed by this proposal:

| Boundary           | Focused behavioral proof                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Detail and consent | Private, Names only, consenting Detailed, legacy Detailed, mixed recipients, account inheritance, old device override, explicit opt-in, unrelated preference saves, and old-client writes. Inspect every recipient's payload.                                                              |
| Authority          | Pairing/token revocation, scope/role loss, profile or binding change, and session visibility denial during awaited preparation produce no delivery.                                                                                                                                        |
| Eligibility        | Silent controls, missing producer terminal message, yielded parents, mirrors, hidden/diagnostic rows, reasoning/tool-only messages, raw errors, and aborted/error states produce no inappropriate completion alert. Mixed final-answer/reasoning/tool blocks expose only the final answer. |
| Fallbacks          | Missing/unsafe labels, ambiguous scope, visible nontext answers, and answer text emptied by normalization use the defined fallback without reading history.                                                                                                                                |
| Display            | Markdown, whitespace, display controls, malformed surrogates, emoji, combining sequences, a grapheme larger than the bound, and exact-boundary truncation stay readable and within the hard limit.                                                                                         |
| Existing behavior  | Category/device mute, quiet hours, agent allowlists, tags/topics, repeated completion handling, and click-through URLs retain their current behavior.                                                                                                                                      |
| Retention          | Transport failures log only existing bounded metadata; previews are absent from unrelated stored records and logs.                                                                                                                                                                         |

Extend the existing gateway event-delivery, preference/protocol, settings, and
service-worker tests. Benchmark affected test files before/after and report
`pnpm test <file> --maxWorkers=1` wall time as required by the test guide. Run the
changed checks and relevant build/type/UI lanes selected by the repository.

For browser evidence, use a fresh test profile, synthetic paired devices and
sessions, isolated SQLite state, and an owned local fixture. Drive the actual
connection-state broadcast into delivery, then the production service worker.
Read back actual `registration.getNotifications()` title, body, tag, renotify,
and routing data; exercise click-through to the exact scoped conversation.
Report separately which authorities or transports were mocked, whether CDP
injected the push, and whether the real encrypted sender or an external push
service was used. Browser registry evidence is not an OS lock-screen screenshot.
Attach inspected settings before/after screenshots for an eventual UI patch.

## Scope and decision requested

Approve or reject the narrow exception allowing final-answer excerpts only for
explicitly consenting Detailed browser recipients, including the compatibility
rule above. Confirm the label dependency and consent UI before implementation.
The decision belongs with the existing notification owners and normal upstream
review; this draft does not assert maintainer acceptance.

Telegram, native application notifications, automation routing, category
expansion, live configuration, scheduled jobs, subscriptions, and production
databases are outside this proposal. No runtime behavior, settings UI, protocol,
or stored data changes are included here, and no mocked or real-browser preview
test results are claimed.
