---
doc-schema-version: 1
summary: "Review dictated filenames against authorized local workspace metadata"
read_when:
  - Trying the experimental file-reference controls in the Chat composer
  - Understanding file identity, draft storage, and conversion before sending
title: "Dictated file references"
---

This experimental Chat composer flow binds a selected local file's identity to
an unsent draft. It is off by default. The proposed shared dictation coordinator
and support for additional providers remain separate integration work.

## Review a spoken filename

Enable **English file-reference commands for this session's local workspace**.
This enables the English command grammar for the current connection and session;
it does not change the speech recognition provider or its language setting.
The choice is temporary and resets when the composer or its connection changes.

Dictate an explicitly delimited command, for example:

> Please inspect reference file src slash auth dot ts end reference tomorrow.

After finalized transcription, the original words remain in the draft while the
chooser searches authorized metadata. Inspect the relative path and workspace,
select the intended file, then choose **Insert bound reference**. Confirmation
revalidates the object and replaces that command's words with its visible
reference in one editor transaction. Several commands are reviewed in spoken
order. Undo and redo restore both the visible text and its identity.

Ordinary prose mentioning “reference file” is unchanged. **Literal mode** keeps
all command-like wording as prose. Quoted or backtick-delimited text and
`literal … end literal` spans are also protected. The separate **Allow a whole
utterance beginning with reference file** option enables the shorter form only
when the entire utterance is that command.

Search prefers an exact relative path, then an exact filename, then normalized
spoken words. Exact paths preserve case. Every match requires selection; an
incomplete page never establishes uniqueness. **Next candidates** continues a
bounded search. Use **Inspect full path and workspace** for long or bidirectional
names. **Cancel** or Escape dismisses the chooser without inserting a reference.

## Supported provider and destination

The initial provider uses the current session's authorized local filesystem
workspace, including its existing live sandbox backing. It reuses the file
browser's session and host-read authorization. A local-looking path does not
make a remote workspace eligible. Repository, device, exec-node and other remote
providers, multiple simultaneous roots, and the current-file shortcut are not
supported by this implementation.

Only the mounted Chat editor advertises the reference identity namespace. If a
destination cannot carry it, **Copy relative path** and **Copy reference text**
copy ordinary text without changing the draft. Clipboard text has no bound
identity. An unknown insertion outcome requires inspecting the draft; it does
not trigger another insertion or copying attempt.

Each chooser has a 60-second provider lease, at most 20 displayed candidates and
10,000 examined entries per index chunk. Queries are limited to 2 KiB and
transcripts to 32 KiB with at most 16 commands. Hidden names, `node_modules`,
`dist` and `coverage` are excluded, and directory traversal stops at 64 levels.
The provider rejects traversal, unsupported URI schemes and symlink escapes.

Editing or replacing the draft, starting another capture, changing the target,
disconnecting, or changing authorization cancels the pending review. Renamed,
deleted or replaced objects require a new review. Search and selection read file
metadata and hold unread descriptors; they do not read or attach file contents,
send the message, execute code or grant an agent access.

## Saved drafts and sending

Draft restoration and pane handoff retain supported reference identities.
The opaque object identifier belongs to the chooser's resolver lease. After that
lease is released or expires, a saved draft retains the record validated at
insertion; this implementation cannot resolve that saved identifier again.
Long-lived resolution and identity-capable message delivery remain required
integration work.
Turning the feature off cancels pending work while preserving existing draft
references. Explicitly replacing a draft clears its previous bindings, including
when the replacement has the same visible text.

The current conversation transport cannot deliver this identity namespace.
Sending, queued delivery and suggestion sharing therefore refuse a draft that
still contains bound references. Choose **Convert file references to plain text**
to remove the bindings explicitly, then send through the usual controls. This
conversion does not attach the files or establish downstream permissions.

Identity-bearing session storage uses format 5; current readers also accept
format 4. The shared durable browser database advances to version 3 without
rewriting its stored records. Older application versions that open version 2
cannot access that upgraded database. Continue with a compatible version to
recover those drafts; a binary downgrade does not make identities readable by
older code. Unknown future reference schemas are retained without being
converted to sendable text or overwritten by this reader.

Native browser, assistive-technology and installed upgrade/downgrade qualification
must be completed before this experimental flow is considered release-ready.
