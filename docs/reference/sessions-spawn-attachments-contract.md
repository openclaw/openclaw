---
title: "sessions_spawn attachment contract"
summary: "Current contract for inline attachments passed to native sub-agent spawns"
read_when:
  - You are changing sessions_spawn inline attachments
  - You are reviewing attachment validation, redaction, materialization, or cleanup
  - You are troubleshooting sessions_spawn attachment behavior
---

# `sessions_spawn` attachment contract

This page describes the current contract for inline `sessions_spawn` attachments. Inline attachments are snapshot-by-value inputs from a requester run to a native sub-agent run. They are intended for small files that a child agent needs as concrete workspace inputs, such as snippets, configs, or small binary payloads. They are not a streaming or shared-filesystem mechanism.

The original implementation landed in [#16761](https://github.com/openclaw/openclaw/pull/16761). Keep this page aligned with the shipped schema, validation, materialization, transcript redaction, prompt note, and cleanup behavior.

## Scope

Inline attachments are supported only for `sessions_spawn` with `runtime: "subagent"`. ACP runtime rejects inline attachments; ACP needs a separate explicit transport contract before accepting file payloads.

The feature is default-off behind `tools.sessions_spawn.attachments.enabled`. Supplying attachments while the flag is disabled returns an error instead of silently dropping the payload.

`src/agents/tools/sessions-spawn-tool.ts` should stay a thin schema/dispatch wrapper. Validation, materialization, prompt notes, and spawn-failure cleanup belong in the native sub-agent spawn path.

## Request API

A `sessions_spawn` request may include:

```ts
attachments?: Array<{
  name: string;
  content: string;
  encoding?: "utf8" | "base64";
  mimeType?: string;
}>;
attachAs?: {
  mountPath?: string;
};
```

`attachments[].content` is the complete file content. `encoding` defaults to `"utf8"`. `"base64"` means `content` is base64 text for the decoded bytes. `mimeType` is caller-supplied metadata only and does not affect path resolution or validation. `attachAs.mountPath` is a hint for user-facing messaging; the current implementation materializes into the child workspace and does not use `mountPath` as path authority.

## Default limits

The default limits are:

| Limit                 |   Default | Unit                           |
| --------------------- | --------: | ------------------------------ |
| `maxFiles`            |        50 | files                          |
| `maxFileBytes`        | 1,048,576 | decoded bytes per file         |
| `maxTotalBytes`       | 5,242,880 | decoded bytes across all files |
| `retainOnSessionKeep` |   `false` | boolean                        |

Config may override these values through `tools.sessions_spawn.attachments`, but every numeric limit is interpreted as an integer count of decoded bytes or files. Non-finite or negative values are normalized before use.

Base64 validation includes a pre-decode guard derived from decoded byte limits. The implementation rejects over-limit encoded input before allocating the decoded buffer, then verifies decoded byte length after decoding. Whitespace handling, alphabet checks, and padding checks are deterministic and covered by focused tests.

## Name and path rules

Attachment names are logical filenames, not paths. The current implementation accepts only single-segment names.

It rejects names that are empty, `.` or `..`, `.manifest.json`, contain `/`, `\\`, NUL, ASCII control characters, tab, carriage return, or newline. It also rejects duplicate names. Unsafe names are not silently rewritten because rewriting can hide collisions and ambiguous user intent.

Materialized files live under the child workspace at:

```text
.openclaw/attachments/<id>/
```

Receipts and prompt notes use relative POSIX paths rooted at the child workspace, plus sanitized metadata only.

## Materialization

Materialization happens after validation and before the native sub-agent is started. OpenClaw creates an attachment directory, writes each file, and writes a content-free manifest:

```json
{
  "relDir": ".openclaw/attachments/<id>",
  "count": 2,
  "totalBytes": 1234,
  "files": [{ "name": "input.txt", "bytes": 1200, "sha256": "..." }]
}
```

The manifest never contains raw attachment content. Hashes are allowed for integrity and debugging. Directory permissions are restricted to the owner where the platform supports modes, and file writes go through the private file store so attachments do not overwrite existing files outside the attachment directory.

If validation or writing fails, OpenClaw removes the partially created attachment directory best-effort before returning an error.

## Transcript redaction

Raw attachment content must not persist in transcripts, session repair output, handoff logs, or backfilled tool-call records.

Redaction covers both common tool-call shapes:

- `toolCall.arguments.attachments[].content`
- `toolUse.input.attachments[].content`

The redacted shape preserves non-sensitive metadata needed for debugging, such as `name`, `encoding`, and `mimeType`, while replacing content with a redaction marker.

## Child prompt note and receipt

After successful materialization, the child run receives a concise runtime note with the number of files, total decoded bytes, the relative attachment directory, and a reminder that attachments are untrusted input. The note does not include raw content or absolute host paths.

The requester receives an attachment receipt with the file count, total bytes, file metadata, hashes, and `relDir`.

## Cleanup and retention

Cleanup is tied to the sub-agent run lifecycle.

`cleanup: "delete"` removes the attachment directory after the run/announce cleanup path. `cleanup: "keep"` retains the directory only when `tools.sessions_spawn.attachments.retainOnSessionKeep` is `true`; otherwise the default is to remove attachment material after completion while keeping the session transcript according to existing session cleanup rules.

If the sub-agent spawn fails after materialization, OpenClaw removes the attachment directory best-effort before returning the error. Deletion is constrained to the canonical attachments root inside the child workspace to avoid path traversal or symlink-based deletion outside the attachment area.

## Non-goals

Inline attachments do not implement streaming uploads, remote URL fetching, cross-runtime ACP attachment transport, host absolute path mounts, shared mutable directories, automatic MIME sniffing, or configurable retention schedules beyond the simple keep/delete behavior above.
