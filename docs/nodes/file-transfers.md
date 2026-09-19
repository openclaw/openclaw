---
summary: "Upload files into a node terminal and move files with the File Transfer plugin"
read_when:
  - Dragging files into a paired-node terminal
  - Listing, fetching, or writing files on a node
  - Reading directory fetch limits and transfer policy checks
title: "Node file transfers"
sidebarTitle: "File transfers"
---

## Terminal file uploads

The Control UI can drag files into an open paired-node terminal. The native node host advertises the admin-only `terminal.upload` command; approve the pairing upgrade when it first appears. Each file is limited to 16 MiB, staged in a private temporary directory on that node, and returned to the terminal as a shell-quoted path without executing it.

Path insertion supports PowerShell, `cmd.exe`, and recognized POSIX shells (`sh`, Bash, Dash, Ash, Ksh, Zsh, and Fish), including Git Bash on Windows. Other shell overrides are refused because their quoting rules cannot be inferred safely; run the node host inside WSL for native WSL paths. `cmd.exe` paths containing `%` or `!` are also refused because that shell expands those characters even inside double quotes.

## Agent file transfers

The [File Transfer plugin](/plugins/reference/file-transfer) provides independently
selectable directory-listing, fetch, and write tools. Allowing one tool does not
make the others available; node-command and path policies still apply.

### Gateway workspace files

The File Transfer plugin can connect Gateway workspace-file callers to an
already paired node. Configure the agent ID, exact node ID, and the node's
absolute POSIX workspace path:

```json5 validate=false
// plugins.entries.file-transfer.config
{
  policyVersion: 2,
  workspaces: {
    main: { nodeId: "<paired-node-id>", remoteRoot: "/workspace" },
  },
  nodes: {
    "<paired-node-id>": {
      ask: "off",
      allowReadPaths: ["/workspace/AGENTS.md"],
      allowWritePaths: ["/workspace/AGENTS.md"],
      followSymlinks: false,
    },
  },
}
```

Placement does not grant access. Authorize the required node commands and file
paths separately; the example grants only `AGENTS.md`. Gateway callers retain
their own document allowlists. Use the canonical workspace root. Document reads
and writes reject symlinks. Bootstrap reads can follow directory aliases inside
that root when the node policy permits it; final-file symlinks remain rejected.
There is no local-file fallback while the
configured node is unavailable or its workspace service is stopped.
Agents sharing a Gateway workspace must use the same node and remote root;
identical mappings share one binding, while conflicting mappings fail startup.

| Workspace operation                        | Node command |
| ------------------------------------------ | ------------ |
| Read bytes and their canonical source path | `file.fetch` |
| Write bytes                                | `file.write` |
| List directory entries                     | `dir.list`   |
| Read type, size, and modification time     | `file.stat`  |

`file.stat` adds no model tool. It accepts regular files and directories without
fetching contents or listing the parent, under the existing read-path policy.
For bootstrap reads, `file.fetch.rootPath` confines parent-alias resolution to
the canonical workspace root; it does not grant access beyond the node policy.
Unary reads and writes retain the 16 MiB transfer limit; directory reads consume
the existing `dir.list` pages. `file.write.expectedSha256` verifies the submitted bytes, not
the previous file version. Owner-document conflict checks remain in the Gateway.

This mapping covers workspace files only. Memory search, skill management, and
attachment staging require their respective workspace capabilities; this mapping
alone does not enable a complete storage split or launch an agent harness.

### Binary transfers for services

Plugin services can use the existing node channel to transfer file bytes:

- `file.fetch` accepts binary transfer when both hosts support it, bounded by the caller's byte limit and node policy. Existing unary calls keep their current behavior.
- `file.create` receives bytes over that channel and publishes a complete file without replacing an existing file. It checks the admitted size and SHA-256 digest before publishing.

Both commands retain node pairing, file-path authorization, and approval checks.
These transport commands do not automatically stage task attachments; the workspace adapter supplies that integration.

### Transferred files

Every successful file fetch saves the bytes in the Gateway's file-transfer media
store and returns both `localPath` and `mediaId`, including for inlined text and
images. Fetched files keep a sanitized filename stem in saved copies and forwarded
attachments. The detected media type selects the extension: `train.py` classified
as plain text becomes `train.txt`. Saved copies include a unique suffix to keep
repeated fetches distinct.

When node writing is available, pass that `mediaId` as `sourceMediaId` to
reuse the saved bytes. `sourceMediaId` does not accept a local path or an ID from
another media store. For inline bytes, use `contentBase64` instead.

Directory tools return at most 8192 UTF-8 bytes of model-visible text, including
the external-content wrapper. `dir_list` shows complete names, directory flags,
and sizes. To continue a text-limited listing, pass the **text's** `nextPageToken`
as `pageToken` with the same node and path; it resumes immediately after the last
displayed entry. The default request remains 200 entries, with a ceiling of 5000.
Full returned metadata and the original page token remain in structured details.

`dir_fetch` saves the whole tree and shows its local `rootDir`, total `fileCount`,
and a bounded prefix of complete `relPath` and size records. Combine `rootDir`
with a listed `relPath` for local follow-up operations. Omitted files remain
saved under that root and can be inspected with available local file or directory
capabilities; fetching has no pagination. Full manifest and attachment metadata
remain in structured details. If a path exceeds the text budget or would be
rewritten by security sanitization, the text reports the omission rather than
showing a partial or altered path. A listing that cannot display its first entry
explicitly reports that pagination cannot advance.

Directory fetch policy checks the source-tree descendants and then the archive
member identities admitted by the same bounded parser and policy planner used
for extraction. It does not use human-readable `tar` listings: admitted Unicode
and newline names retain their exact spelling, and producer-added AppleDouble
files are checked rather than hidden. Parent paths are checked even when the
archive omits directory headers. The 5000-descendant cap includes those implicit
directories, counting shared parents only once. A denied path rejects the whole transfer.
Canonical source path/device/inode binding, byte-count and SHA-256 verification,
link/traversal/collision checks, and extraction limits still apply. Malformed
archive headers and destination-platform filename restrictions still reject;
filenames are not truncated or repaired to make an archive pass.
