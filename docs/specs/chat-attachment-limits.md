---
title: Chat attachment limits
summary: "Implementation proposal separating chat attachment admission from media-specific limits."
read_when:
  - Configuring per-file and per-message chat attachment limits
  - Separating document uploads from media processing budgets
---

# Chat attachment limits

Status: **implementation proposal**. This branch implements independent size
limits for incoming Gateway user-chat attachments; it does not add a large-file
upload transport or change all channel and outbound-file contracts.

Related: [large Control UI uploads, #166757](https://github.com/openclaw/openclaw/issues/166757).
This is the configuration/admission part of that discussion, not a resolution
of its streaming-upload requirement.

## Configuration

```json5
{
  attachments: {
    maxFileMb: 10,
    maxTotalMb: 15,
  },
}
```

| Configuration key        | UI label                                  | Default                                                |
| ------------------------ | ----------------------------------------- | ------------------------------------------------------ |
| `attachments.maxFileMb`  | Maximum attachment size                   | 20 MiB per file                                        |
| `attachments.maxTotalMb` | Maximum total attachment size per message | The larger of 20 MiB and the configured per-file limit |

Both fields use MiB (1,048,576 bytes), matching the established `Mb` convention.
Values must represent at least one byte and no more than the safe integer byte
range. Fractional MiB values round down to whole bytes. Existing
`attachments.ttlHours` retention behavior is unchanged.

All files count, including images, audio, video, and documents. Two 8 MiB files
pass the example's per-file limit but exceed its 15 MiB message total. Repeated
attachment entries count separately, even when their bytes are identical. Message
text and JSON/Base64 overhead do not count toward decoded file totals, but still
count toward the encoded transport ceiling.

A total below the per-file value is valid: the lower total is the effective
single-file ceiling. Advertised client limits reflect that constraint.

## Separation from media processing

Previously, `agents.defaults.mediaMaxMb` also controlled non-media chat
admission. On this branch, incoming chat file admission and its document staging
use `attachments.maxFileMb` instead. Changing a media budget no longer changes
the document-upload budget after migration.

Media files still face applicable image-hydration, processing, and provider
limits in addition to the general attachment budget. Generated-media budgets
and channel/account `mediaMaxMb` settings retain their existing contracts.

`agents.defaults.mediaMaxMb` stays available and active for incoming **images,
audio, and video only** (chat default: 20 MiB). It is not replaced by the new
options. A media file must fit both that media cap and `attachments.maxFileMb`;
all files together must fit `attachments.maxTotalMb`. PDFs, text, archives, and
other documents do not use the media cap. The parser applies this distinction
after sniffing the content, so renaming an image to `.txt` cannot evade it.

For example, `mediaMaxMb: 5`, `maxFileMb: 10`, and `maxTotalMb: 15` allow an
8 MiB PDF but reject an 8 MiB video. Two 8 MiB PDFs exceed the message total.

This is not yet a claim that `mediaMaxMb` is media-only everywhere in OpenClaw:
outbound document readers and channel adapters need their own reviewed cutover.
Terminal transfers, browser uploads, skill archives, and arbitrary file tools
are not silently brought under these incoming-chat limits.

## Ownership and enforcement

The existing Gateway chat attachment policy resolves decoded file and total
budgets. Parsing checks the entire normalized submitted batch before decoding,
probing, or saving any file. A total-size failure rejects the message before a
model run, rather than silently dropping an attachment. Client-reported MIME
types and filenames do not exempt a file from accounting. Existing MIME checks,
permissions, upload-disable policy, cancellation, and cleanup remain in place.

Chat, session send/creation, agent/node ingress, and companion questions consume
the same parser budgets. Worker attachment transfer retains its own transport
ceiling while honoring the configured file and total limits. The media staging
owner follows the admitted attachment file cap without lowering its existing
staging floor.

The optional `hello-ok.policy.attachments.maxTotalBytes` advertises the resolved
combined ceiling, alongside existing `maxBytes` and `maxImageBytes`. Older
clients can omit aggregate preflight; the server still rejects excess totals.
The Control UI uses the lower of the advertised total and its frame budget.
The optional `maxMediaBytes` advertises the media-only ceiling; `maxImageBytes`
also includes that ceiling. Client audio/video preflight and compression
reservations honor it without reducing the document file limit.
See the [handshake contract](/gateway/protocol/handshake).

Size edits apply to subsequent server requests without a restart. Existing
connections must reconnect to refresh advertised limits. Live policy refresh
remains separately tracked in
[#117552](https://github.com/openclaw/openclaw/issues/117552).

## Upgrade and downgrade

Doctor automatically preserves this policy for eligible single-file configs
during noninteractive upgrades. Run `openclaw doctor --fix` when Doctor requests
an explicit repair. If an existing explicit
`agents.defaults.mediaMaxMb` supplied the old file cap and
`attachments.maxFileMb` is absent, Doctor copies the equivalent whole-byte cap
to the new field. It retains the media setting, explicit new file/total values,
and existing retention settings. The repair is idempotent and uses Doctor's
normal backed-up writer. No permanent runtime legacy fallback is added.

When intentionally configuring a media-only budget, set an explicit attachment
file limit as well; otherwise Doctor treats the missing value as the legacy
inherited file policy to preserve. Before downgrading to an older binary, remove
the two new keys, which older schemas do not recognize.

## Remaining limits and tradeoffs

- The current 25 MiB WebSocket frame and 256 KiB envelope allowance yield a
  conservative 18.5625 MiB combined decoded attachment budget. New settings do
  not bypass it. A larger PDF still needs the upload/reference transport in
  #166757; raising the global frame ceiling is not part of this change.
- More settings are useful only when operators need independent document and
  media budgets. Clearer labels and errors would be the smaller alternative
  if independent control were unnecessary.
- File sizes are not concurrency, disk, pixel, duration, or extraction quotas.
  Compressed expansion and simultaneous messages still require existing
  resource bounds.
- An accepted file is not a promise that a selected model can consume it.
- The top-level name is intentionally scoped in help text to incoming Gateway
  chat size admission; cross-channel and outbound policy remain separate.

## Validation boundaries

Regression coverage includes exact/over-total mixed and duplicate file batches,
no storage/capability work on aggregate rejection, independent media/document
limits, migration precedence/idempotence, schema bounds, worker staging, and
client aggregate preflight. Rendered settings evidence uses the actual Control UI
with a synthetic Gateway configuration response.

A real isolated Gateway/agent test exercises `chat.send` with a deterministic
provider: it rejects disguised media and over-file/over-total batches before
provider dispatch, then accepts and retains a document above the media cap.
Doctor integration coverage verifies backed-up, idempotent migration of a valid
legacy config through the noninteractive update path.

Release qualification still needs an installed latest-stable upgrade rehearsal
and an external live-model attachment flow. Deterministic-provider, migration,
and fixture-backed UI evidence do not substitute for those checks.
