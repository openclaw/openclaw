---
summary: "Preserve recognized Control UI dictation while semantic cleanup is unavailable"
read_when:
  - Choosing a Control UI dictation policy
  - Reviewing or recovering an unsent dictated draft
  - Qualifying dictation source preservation
title: "Conservative dictation cleanup"
sidebarTitle: "Dictation cleanup"
---

Semantic dictation cleanup is **unavailable in this build**. OpenClaw preserves
the recognized text instead of guessing whether a hesitation or repetition was
intentional. There is no approved semantic removal path, and string patterns
cannot supply that decision.

Cleanup starts **Off**, which keeps the existing dictation flow. A recording
made with the existing Conservative preference retains its original recognized
text for review. It does not produce a cleaned candidate or make semantic
removals. Preserving text does not complete the proposed cleanup feature.

This applies to the Control UI Chat, New Session, and session sidebar
composers. Native macOS, iOS, Android, and external application text fields do
not gain a cleanup policy. Speech recognition still uses the existing
[transcription session](/nodes/talk) and its configured provider.

## Choose a policy

Open **Dictation cleanup** in the composer toolbar. The compact control has the
same accessible name.

| Mode                             | Behavior                                                               |
| -------------------------------- | ---------------------------------------------------------------------- |
| **Off**                          | Keeps the recognizer's text and the existing dictation flow.           |
| Conservative, marked unavailable | Keeps the recognized text for review; semantic cleanup is unavailable. |

The existing Conservative option explicitly selects English for this policy.
It does not detect your spoken language or change the recognizer's language.
Use Off for other languages or mixed-language speech. Unsupported cleanup
locales never authorize a text change.

The preference belongs to this browser and Gateway and uses the existing
Control UI settings owner. Changes apply to the next recording. Turning
cleanup Off removes the saved cleanup override and cancels pending preparation.
This repair adds no preference field or shared profile store.

Off cannot recover a word that the recognizer already omitted. The original
shown in review is the text OpenClaw received, not a separate recording or a
verified transcript of everything spoken.

## Review and recover text

After a Conservative recording finishes, open **Review dictation**. The
original recognized text remains available under the existing draft ownership
checks. Semantic cleanup being unavailable does not mean the recording has
been lost. No cleaned acceptance is available, and review never sends a
message.

| Action                  | Result                                                                    |
| ----------------------- | ------------------------------------------------------------------------- |
| **Use original**        | Adds the recognized text without semantic changes and retires the review. |
| **Copy original text**  | Copies the retained text for manual recovery.                             |
| **Close** or **Escape** | Closes the dialog and keeps the review available.                         |
| **Dismiss review**      | Releases the review without changing the draft.                           |

The existing composer still owns insertion spacing. Preserving the preparation
source does not add an exact-syntax insertion mode.

Editing the draft invalidates automatic replacement of that draft. The
retained original remains available to read or copy while recovery is
authorized. **Review again**, when offered after a failed preparation, uses
the current draft. It is unavailable when the missing semantic capability is
already known. Manual copying remains available; there is no phrase search
and replacement elsewhere in the draft or in an already sent message.

If a draft update cannot be confirmed, inspect the current draft before
copying text. The review does not replay an uncertain write. A destination
change or loss of authorization can make the source unavailable; that is
distinct from semantic cleanup being unavailable while original text remains.

Conservative review keeps the existing 32 KiB UTF-8 source limit. A larger
source is not retained in the transient review. That review has no original
text or insertion actions; dismiss it and record a shorter utterance. The
existing Off path keeps its recognized-text behavior.

Conservative keeps one pending review. Resolve it, cancel the pending
dictation, or dismiss the review before starting another capture. Closing the
dialog keeps that review pending. Sending is blocked while a Conservative
recording is finalizing so a second send action cannot drop the pending review.
**Use original** waits for finalization, so it cannot insert an interim transcript.
Once finalization settles, explicitly sending a separate draft retires any
unaccepted review. Off retains the existing ordered queue for stopped recordings.

Use Tab and Shift+Tab to move through the policy, original text and actions.
Enter activates a focused button. Escape belongs to the dialog and returns
focus to its trigger. Review status uses a polite announcement.

## What can change

Preparation does not delete, rewrite, translate, normalize or classify the
recognized speech. Intentional repetition, uncertainty, negation, numbers,
names, quotations, developer literals and correction evidence remain intact.

| Recognized text                        | Preparation result |
| -------------------------------------- | ------------------ |
| `um please call me tomorrow`           | Unchanged          |
| `I I need the invoice`                 | Unchanged          |
| `um I need fifteen sorry fifty copies` | Unchanged          |
| `this is very very important`          | Unchanged          |
| `we should not not without approval`   | Unchanged          |
| `fifteen no fifty`                     | Unchanged          |
| `the variable is um_count`             | Unchanged          |

Recognizer confidence and timing describe recognition; they do not establish
whether a word should be removed. Missing metadata remains missing. A source range or a category label would not authorize semantic deletion.
This review-only path does not accept or construct removal plans.

## Ownership and privacy

This preservation path uses already recognized text and adds no model or
provider request. The existing speech recognizer may still use its configured
remote transcription provider. This change does not make recognition local
or offline.

No audio recording, retry buffer, transcript log, learned rule or personal
speech profile is added. The existing composer dictation owner continues to
own capture, finalization order, draft revisions and publication. Review
retains at most one bounded source in memory; it is not chat history.

Preparation checks the source identity and revision, policy and locale, and
keeps at most 32 KiB of UTF-8 text for original-text review. It does not parse
removal ranges or produce a cleaned candidate. Validate removal plans only
when an approved semantic producer actually supplies edits.

There is no new Gateway RPC or public plugin SDK contract. An accepted
semantic owner, preference scope, shared preparation behavior and preservation
criteria remain decisions for the proposal in
[#205635](https://github.com/openclaw/openclaw/issues/205635). Preserving the
original does not imply acceptance of those contracts or completion of the
broader issue.

## Qualify a change

`ui/src/pages/chat/dictation-cleanup.test-support.ts` contains authored
source-preservation cases. The former semantic-removal labels and expected
deletions are withdrawn. These fixtures cover exact retained text; they are
not independent human annotation or proof of semantic precision.

Real Gateway/provider/microphone behavior across all three composers, actual
keyboard and screen-reader outcomes, served production assets, and the
latest-stable upgrade require their own proof. A preservation fixture or
unexecuted test does not establish those results.
