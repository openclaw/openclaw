---
doc-schema-version: 1
summary: "Review explicitly dictated paragraphs and lists, supported output formats, and safe recovery"
read_when:
  - You want to dictate paragraphs or lists in the Control UI
  - You need to understand formatting preview, insertion limits, or rollback
title: "Dictation formatting"
---

This page describes the reviewable implementation proposed in
[issue #205634](https://github.com/openclaw/openclaw/issues/205634). Its private
formatting contract, browser preference, resource limits, and delivery support
still require acceptance and qualification. It is not a claim of released or
system-wide rich-text insertion support. The
[acceptance ledger](/reference/dictation-formatting-evidence) records the remaining
checks and external dependencies.

## Choose a mode

**Preserve recognized text** is the default. It keeps the existing dictation
placement behavior. Missing, malformed, and unsupported-version formatting
preferences also use Preserve.

**Interpret explicit structure (English)** is an opt-in command grammar. After
Stop, the microphone releases and the final transcript is prepared for review.
Formatting does not send the message. Confirm the phrases intended as commands,
review the semantic or plain preview, then
choose **Use formatted text** or **Keep original** when the captured target is
still eligible. Sending remains a separate action.

The draft remains editable during Explicit recording and finalization. Editing
it invalidates the captured insertion target; the retained recognition can still
be reviewed or copied without overwriting the newer draft. Preserve keeps its
existing recording lock and partial-caption behavior.

The mode control appears with the existing dictation controls and in the review.
Changing the mode affects future recordings and invalidates an older prepared
result. **Reprocess** applies the selected policy to the retained, eligible final
transcript. It does not run speech recognition again, recover missing words, or
retarget a changed draft. Incomplete recognition remains available through
original-text recovery; it is never promoted to a finalized formatted result.

Suggest structure is not enabled. Headings and tables are outside this initial
formatting contract. Spreadsheet operations, attachments, automatic links,
embedded media, and document automation are also outside its scope.

## English command grammar

The supported structures are paragraphs, line breaks, unordered lists, ordered
lists, and nested lists within the current limit. The grammar is deliberately
conservative because a text transcript does not establish whether a phrase was
spoken as an instruction or discussed as ordinary prose.

| Form                                                                                    | Behavior                                                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Shopping list bullet milk next item eggs next item rice`                               | After confirmation of `bullet` and both `next item` phrases, keeps the introduction and prepares three items in order. |
| `bullet milk next item eggs`                                                            | After confirmation, starts an unordered list and adds a second item.                                                   |
| `step three check power step seven restart`                                             | After confirmation, keeps the explicit item numbers 3 and 7.                                                           |
| `start list bullet parent nested list bullet child end list next item sibling end list` | After confirmation of each command, creates a nested list with the child under its original parent.                    |
| `new paragraph`, including a standalone or punctuation-delimited occurrence             | Creates a paragraph boundary only after confirmation of that occurrence.                                               |
| `new line`, including a standalone or punctuation-delimited occurrence                  | Creates a line break inside the current paragraph or item only after confirmation.                                     |
| `Our new paragraph starts with a date`                                                  | Keeps the phrase literal unless that occurrence is explicitly selected as a command.                                   |
| Quotes, backtick/fenced code, URLs, or caller-protected literal spans                   | Keeps marker-looking words literal.                                                                                    |

Every recognized command needs explicit intent confirmation, including list,
numbered-item, paragraph, and line commands. In the review's marker checklist,
check each exact occurrence you intended as a command and choose **Interpret
selected commands**. The choice is tied to the original transcript revision.
Punctuation or words such as "points" do not establish intent. For example,
`Shopping list bullet points to discuss next item budget` can become two items
after confirming `bullet` and `next item`; leaving them unchecked preserves the
original words.

Confirmation cannot consume arbitrary words or override quoted/code protection.
Inspect the resulting structure before applying it. Unselected phrases remain
literal. Outside list items and protected literal spans, existing paragraph
separators remain paragraph boundaries. A list opener must be followed by an
item command such as `bullet`; unsupported or incomplete
structures retain the original instead of guessing missing content.

Numbers, quantities, names, negation, item order, and protected content remain
source-backed. Unsupported or empty structures retain a readable original
candidate with a review or fallback status. No renderer paraphrases the content.

## Output formats and targets

One validated document produces all three representations. Preparing a format
and successfully inserting it are separate outcomes.

| Representation              | Contract                                                                                                       | Current delivery boundary                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plain text                  | Paragraph spacing, line breaks, and readable list markers                                                      | Plain preview/copy and original-text recovery through an eligible captured target.                                                               |
| Markdown                    | `commonmark-0.31.2-lists`: escaped text, paragraphs, hard breaks, and ordered/unordered lists                  | Chat, New Session, and Side chat only when the captured draft is empty or the entire draft is selected and the target supports an undoable edit. |
| Rich text                   | `safe-blocks-v1`: deterministic `p`, `br`, `ul`, `ol`, and `li` nodes; numeric list `start`/`value` attributes | Semantic preview and preparation only. Native/external rich insertion is not qualified.                                                          |
| Unknown or stale capability | Readable plain candidate                                                                                       | Explicit review/copy; no automatic insertion into another target.                                                                                |

The Markdown restriction prevents surrounding code fences, blockquotes, or list
syntax from changing the meaning of a prepared result. For a partial selection
inside an existing Markdown draft, use the recovery controls or explicitly select
the whole intended draft before starting a new recording. The formatter does not
infer support from an application name, browser title, or current foreground app.

**Keep original** replaces only the captured range. The rich composer uses its
existing editor transaction to retain unaffected recipient records and include
mention invalidation in the same Undo step. Native textarea history and actual
recipient retention still require the execution described in the acceptance
ledger. Intentional whole-draft proposals keep their existing whole-draft Undo
contract.

Explicit step numbers can be repeated or skipped. The Markdown serializer starts
a new ordered-list segment when necessary because CommonMark otherwise derives
later labels from the first item. The rich representation preserves each numeric
label directly. These representations must pass independent-parser checks before
their support is reported as verified.

Literal Markdown punctuation is escaped. Rich output comes only from the
allowlisted serializer, never from generated HTML. Script elements, event
handlers, styles, images, remote resources, and arbitrary clipboard MIME types
are not part of the representation. A spoken URL remains text and is not fetched.

## Review, cancellation, and recovery

The semantic preview uses actual paragraphs and lists. The plain preview is a
read-only text equivalent; **Recognized text** retains the source for comparison.
Use the native selectors and buttons with the keyboard. Escape dismisses review,
and the dismissal path restores focus to the composer. Status announcements
describe readiness, fallback, and delivery without announcing every partial
caption. Actual screen-reader and large-text qualification is recorded separately
in the acceptance ledger.

Apply is tied to the capture's draft, selection, connection/account, mode,
formatting policy, focus ownership, and target-capability revision. An edit,
scope change, cancellation, or lost eligibility prevents the older preparation
from overwriting newer work. Reprocessing does not acquire a different target.

Delivery reports one of three outcomes:

- **Not committed:** no successful edit has been confirmed; review and eligible
  recovery controls remain available.
- **Committed:** the existing text adapter confirmed the edit. Review the message
  before sending and use that editor's normal Undo if needed.
- **Outcome unknown:** an indivisible edit was attempted but its effect could not
  be confirmed. Inspect the destination before copying anything. There is no
  automatic plain-text retry.

**Copy plain text** is an explicit clipboard action. If copying fails, select and
copy the plain preview manually. Dismissal and cancellation do not claim to undo
an already attempted edit. Formatting does not press an action key, submit a
form, create an attachment, or execute dictated text. Terminal insertion is not
a qualified target.

## Settings and rollback

The optional `dictationFormatting` policy lives in the existing Gateway-scoped
browser settings record. Version 1 stores only the Explicit opt-in; Preserve is
represented by absence. The preference is not part of synchronized `ui.prefs` and
does not change another browser's setting. Load and save both reject unsupported
versions and modes to Preserve and remove unrecognized policy properties.

Choose **Preserve recognized text** to disable formatting for future recordings.
Reprocess an eligible unsent review in Preserve or choose its original-text
recovery. Disabling the feature does not delete the current draft, change speech
provider settings, or reformat stored messages. An older client may ignore or
drop the optional policy on its next settings write; recognized-text dictation
remains the downgrade path.

Preparation is local and deterministic and adds no provider request. Existing
speech capture and provider selection remain with the Talk transcription owner.
This does not make a remote speech provider local or establish an offline speech
recognition guarantee. Formatting adds no transcript history or durable content
diagnostics. The current review is transient; existing draft persistence continues
to own text after an accepted edit.

## Resource limits and qualification

The private prototype currently bounds a transcript at 32 KiB of UTF-8, with at
most 100 blocks, 100 total list items, depth 3, 1,000 runs, 500 consumed markers,
512 protected ranges, and 20 recognized, unprotected command candidates per
transcript. If that last limit is exceeded, review keeps the complete original
and offers no partial command checklist. These ceilings require corpus, UI, and
maintainer qualification. Oversize or invalid input keeps an original-text
fallback; it is not silently truncated.

The proposed private finishing deadline is 2,500 ms from Stop for Explicit
preparation. A deadline cannot authorize a late publication or turn a partial
caption into a complete result. Provider, validation/rendering, and total latency
must be reported separately. The proposed validation-plus-rendering goal is
50 ms p95 for a 10,000-character workload. The current benchmark fixtures stay
within the confirmation limit: paragraph workloads have 20 commands and 21
blocks; the nested workload has 18 commands, seven blocks, and depth three.
They have not been executed on this repair revision. Earlier measurements do
not qualify the changed parser, validator, or workloads.

The required rich-editor insertion/undo proof, real microphone-to-list journey,
current-build accessibility evidence, and final-head CI remain separate release
gates. See the [acceptance ledger](/reference/dictation-formatting-evidence) for
their procedures and current status.

## Related

- [Control UI](/web/control-ui)
- [Chat and composer](/web/control-ui/chat)
- [Control UI settings](/web/control-ui/settings)
- [Talk transcription sessions](/nodes/talk/realtime-sessions)
- [Dictation formatting evidence](/reference/dictation-formatting-evidence)
