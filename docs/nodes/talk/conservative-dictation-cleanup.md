---
summary: "Review narrow English dictation cleanup in the Control UI while keeping the original recognized text"
read_when:
  - Choosing whether to clean up Control UI dictation
  - Reviewing or recovering an unsent dictated draft
  - Qualifying the private dictation cleanup contract
title: "Conservative dictation cleanup"
sidebarTitle: "Dictation cleanup"
---

Conservative dictation cleanup suggests a small set of deletions from finalized
English transcripts in the browser Control UI. You review the original and the
candidate before adding text to the unsent draft. Cleanup starts **Off**, so
existing users keep the recognizer's output.

This feature applies to the Control UI Chat, New Session, and session sidebar
composers. Native macOS, iOS, Android, and external application text fields do
not gain this cleanup policy. Speech recognition still uses the existing
[transcription session](/nodes/talk) and its configured provider.

## Choose a policy

Open **Dictation cleanup** in the composer toolbar. The compact control has the
same accessible name. Choose a **Cleanup mode**:

| Mode                       | Behavior                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Off**                    | Keeps the text the recognizer returns and preserves the existing dictation flow.                            |
| **Conservative — English** | Checks narrow English patterns after recognition and offers a final review before adding text to the draft. |

Choose Conservative only when dictating English. Selecting it explicitly sets
the cleanup language to English. It does not detect your spoken language or
change the recognizer's language. Use Off for other languages or mixed-language
speech.

The preference belongs to this browser and Gateway. It is saved through the
existing Control UI settings owner. Changes apply to the next recording.
Turning cleanup Off removes the saved cleanup override and cancels pending
cleanup suggestions. It does not rewrite chat history or learn a rule about
your speech.

Off cannot recover a word that the recognizer already omitted. The original in
the review is the recognized text OpenClaw received, not a separate recording
or a verified transcript of everything spoken.

## Review and recover text

After a Conservative recording finishes, open **Review dictation**. The dialog
shows **Original recognized text**, **Cleaned draft**, and the source text of
any suggested removals. Both text views are read-only. Cleanup does not send
the message.

| Action                                  | Result                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Use cleaned draft**                   | Adds the reviewed candidate to the current unsent draft. A restoration receipt remains while that draft is still owned and unchanged. |
| **Use original — restore all removals** | Adds the recognized text without cleanup and retires the candidate.                                                                   |
| **Restore original**                    | Restores the recognized text after accepting cleanup, while the exact owned draft is unchanged.                                       |
| **Copy original text**                  | Copies the retained recognized text for manual recovery.                                                                              |
| **Retry cleanup**                       | Reprocesses retained recognized text when retry is available. It does not start another recording.                                    |
| **Close** or **Escape**                 | Closes the dialog and keeps the review available.                                                                                     |
| **Dismiss review**                      | Releases the review without changing the current draft.                                                                               |

Type an edit in the composer before sending if you want to make a different
change. Once your edit invalidates the restoration receipt, replacement
buttons are disabled. The retained original remains available to read or copy
when the current review permits recovery. Cleanup never finds and replaces a
matching phrase elsewhere in the draft or in an already sent message.

For an unaccepted review, **Retry cleanup** explicitly prepares the retained
recognized text against your current draft with the selected cleanup policy.
Sending a message retires its restoration receipt. Reviewing or accepting
cleanup alone never sends one.

If a draft update cannot be confirmed, check the current draft before doing
anything else. The review can offer its retained original for copying, but it
does not replay an uncertain write or enable automatic replacement.

Conservative review does not retain a source larger than 32 KiB of UTF-8 text.
That review shows an unavailable state without original text, a candidate, or
replacement actions. Dismiss it and record a shorter utterance. The existing
Off path keeps its recognized-text behavior.

Conservative keeps one pending review. Resolve it, cancel the pending dictation,
or dismiss the review before starting another capture. Closing the dialog alone
keeps that review pending. Off retains the existing ordered queue for stopped
recordings. Concurrent pending Conservative reviews are not supported.

Use Tab and Shift+Tab to move through the policy, text views, and actions.
Enter activates a focused button. Escape closes the dialog and returns focus
to its trigger. Review status uses a polite announcement rather than
interrupting capture for each possible hesitation.

## What can change

The initial rules recognize only narrow source-prefix constructions. Examples
include a lowercase `um` or `uh` before `please call`, and an exact `I I` restart
before `need`. Punctuation and capitalization are preserved except for the
source characters in an accepted removal. Cleanup does not translate, rewrite
grammar, shorten sentences, or add punctuation.

| Recognized text                      | Suggested candidate       |
| ------------------------------------ | ------------------------- |
| `um please call me tomorrow`         | `please call me tomorrow` |
| `I I need the invoice`               | `I need the invoice`      |
| `this is very very important`        | Unchanged                 |
| `I like the blue one`                | Unchanged                 |
| `we should not not without approval` | Unchanged                 |
| `fifteen no fifty`                   | Unchanged                 |
| `the variable is um_count`           | Unchanged                 |
| `Um please call me tomorrow`         | Unchanged                 |

A repeated word can carry intent. Choose the original whenever a suggested
removal loses that intent. The rules favor retention: quotation or code
evidence, correction markers, non-ASCII text, unsupported declared locales,
protected ranges, and uncertain continuation evidence can prevent cleanup.
Low recognizer confidence can veto a deletion. It never authorizes one.
Missing timing and confidence remain missing.

## Ownership and privacy

Cleanup runs locally on already recognized text and adds no model provider
request. This does not make the existing speech recognizer local or offline.
Recognition can still require the configured transcription route. Cleanup adds
no audio recording, audio retry buffer, transcript log, or learned speech
profile.

The existing composer dictation owner keeps capture, ordered finalization,
draft revisions, and publication together. Partial recognition stays outside
the cleanup candidate. A new recording, user edit, target change, cancellation,
or disposal can retire the right to replace a draft. A late cleanup result
cannot regain that right.

The private transform in `ui/src/pages/chat/dictation-cleanup.ts` receives a
source ID, revision, finalized text, a versioned policy, and any genuine
metadata supplied by the caller. It returns the immutable raw text, candidate,
removal records, and a source map. Each removal uses half-open UTF-16 offsets
into the original source. The validator checks source identity, grapheme
boundaries, protected spans, edit order, and allowed deletion patterns before
reconstructing the candidate from retained source slices.

Cleanup admission is bounded to 32 KiB of UTF-8 text, 4,096 metadata ranges per
collection, and 64 proposed removals. A plan cannot remove more than one quarter
of the source. Invalid or ambiguous plans retain eligible recognized text.
The transient review owner drops an oversized source instead of retaining it
for recovery. This is a private Control UI contract, with no new Gateway RPC or
public plugin SDK registration. Future correction or punctuation work must preserve this source
identity and the single publication owner. See the implementation discussion
in [#205635](https://github.com/openclaw/openclaw/issues/205635).

## Qualify a change

The authored corpus in `ui/src/pages/chat/dictation-cleanup.test-support.ts` balances
safe-removal cases, required retention, and ambiguous retention. These are
synthetic fixtures. They are not independently annotated recordings or proof
of a population-wide error rate.

Run the maintained local benchmark from a source checkout:

```sh
node --expose-gc --import ./scripts/tsx.mjs scripts/bench-dictation-cleanup.mts
```

It emits the environment, an exactly 2,000-character workload identity,
interleaved Off and Conservative timings, corpus outcomes, and repeated-session
heap and RSS samples. The Off samples are a control in the current revision.
They are not measurements of a pre-feature checkout.

The cold measurement is the first cleanup call in a fresh Node process after
module import. Warm measurements follow explicit warmup. Neither measures
microphone acquisition, recognition latency, browser rendering, or model work.
The proposed 25 ms p95 stage budget and the script's retained-heap guard are
local qualification checks, not an agreed reference-hardware launch gate.

Report false deletions and critical-token preservation separately from deletion
volume. Qualify actual microphone/provider behavior and a named screen reader
separately. Passing deterministic fixtures does not establish either result.
