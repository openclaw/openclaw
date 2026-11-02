---
summary: "Upload files into a node terminal and move files with the File Transfer plugin"
read_when:
  - Dragging files into a paired-node terminal
  - Listing, fetching, or writing files on a node
  - Reading directory fetch limits and transfer policy checks
  - Keeping agent workspace files on a paired node
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
their own document allowlists. Use the resolved workspace root. Document reads
and writes reject symlinks. Bootstrap reads can follow directory aliases inside
that root when the node policy permits it; final-file symlinks remain rejected.
There is no local-file fallback while the
configured node is unavailable or its workspace service is stopped.
Agents sharing a Gateway workspace must use the same node and remote root;
identical mappings share one binding, while conflicting mappings fail startup.

| Workspace operation                       | Node command |
| ----------------------------------------- | ------------ |
| Read bytes and their resolved source path | `file.fetch` |
| Write bytes                               | `file.write` |
| List directory entries                    | `dir.list`   |
| Read type, size, and modification time    | `file.stat`  |

`file.stat` adds no model tool. It accepts regular files and directories without
fetching contents or listing the parent, under the existing read-path policy.
For bootstrap reads, `file.fetch.rootPath` confines parent-alias resolution to
the resolved workspace root; it does not grant access beyond the node policy.
Unary reads and writes retain the 16 MiB transfer limit; directory reads consume
the existing `dir.list` pages. `file.write.expectedSha256` verifies the submitted bytes, not
the previous file version. Owner-document conflict checks remain in the Gateway.

With the Gateway's node duplex transport, the mapping also registers Memory file
access, workspace Skill management, and input attachment staging. Each operation
still needs its command and path grants. The mapping does not launch an agent
harness or move all Gateway state. Use the following example to configure both
hosts.

### Split-storage setup

Use this setup to keep the `main` agent's workspace on a persistent Linux node.
The Gateway keeps configuration, credentials, sessions, and canonical media
references. The node stores workspace documents, Memory source files, workspace
Skills, and staged input attachments. Memory indexing and search configuration
remain Gateway-owned; there is no separate remote Memory switch.

| Host        | Responsibility                                      | Example workspace path         |
| ----------- | --------------------------------------------------- | ------------------------------ |
| Gateway     | Maps the agent workspace and authorizes node access | `/srv/openclaw/workspace-main` |
| Paired node | Stores files and runs the workspace file services   | `/workspace`                   |

These paths can differ. The Gateway path identifies the workspace binding;
`remoteRoot` identifies the actual node directory. This setup does not copy an
existing Gateway workspace.

#### Prepare and pair the node

Install matching OpenClaw builds on both hosts. The bundled File Transfer plugin
is enabled by default; the examples enable it explicitly. If either host uses
`plugins.allow`, add `file-transfer` to that host's existing list. Keep other
required plugins in the list.

Create `/workspace` on the node and give the node service account read and write
access. Use its resolved absolute path, with no symlink aliases. Before enabling
the Gateway mapping, populate this directory:

- For an existing agent, copy its workspace files from the current host. Preserve
  its instructions and Memory files, and keep a backup before switching hosts.
- For a fresh agent, create `AGENTS.md` and the other documents needed by that
  agent. Start from the templates in the [workspace file map](/concepts/agent-workspace#workspace-file-map)
  and customize them for the agent. Do not overwrite existing documents.

Confirm that `/workspace/AGENTS.md` exists and is readable and writable by the
node service account. The Gateway does not create bootstrap documents after a
remote workspace mapping is registered.

Merge this into the **node's** `openclaw.json`:

```json5
{
  agents: {
    entries: { main: { workspace: "/workspace" } },
  },
  plugins: {
    entries: {
      "file-transfer": { enabled: true },
    },
  },
}
```

Memory and Skills requests require `remoteRoot` to match a configured node
agent's workspace. The node's agent ID need not match the Gateway's agent ID.
Do not copy the Gateway's file-path policy into the node configuration: the
Gateway owns that policy.

From the Gateway Control UI **Devices** page, create a node setup link. Run it
on the node, under the account that owns `/workspace`:

```bash
openclaw node run --pair "oc-pair://<setup-code>"
```

Keep the node running. On the **Gateway**, inspect pairing status. An
administrator-issued setup code can approve the initial device and command
surface automatically. If requests remain pending, inspect and approve them;
device pairing and command-surface approval have distinct request IDs:

```bash
openclaw devices list
# Only if a device request is pending:
openclaw devices approve <deviceRequestId>
# After device approval, wait for the node to reconnect.
openclaw nodes pending
# Only if a command-surface request is pending:
openclaw nodes approve <nodeRequestId>
openclaw nodes status
openclaw nodes describe --node <paired-node-id>
```

Use the signed node ID from this output in both places in the next example.
Do not substitute a display name or the `node run --node-id` client instance ID.
For an existing node, reconnect it after enabling the plugin and approve any
new command-surface request. A saved [`--commands` restriction](/cli/node#run-foreground)
still applies when you omit the flag; update it deliberately if it excludes a
required command.

#### Configure the Gateway

Merge this into the **Gateway's** `openclaw.json`. Preserve existing model,
channel, authentication, and plugin settings. Replace both node ID placeholders
with the same approved node ID:

```json5
{
  agents: {
    entries: { main: { workspace: "/srv/openclaw/workspace-main" } },
  },
  gateway: {
    nodes: {
      commands: {
        allow: [
          "file.fetch",
          "file.write",
          "dir.list",
          "file.stat",
          "file.create",
          "workspace.memory",
          "workspace.skills",
        ],
      },
    },
  },
  plugins: {
    entries: {
      "file-transfer": {
        enabled: true,
        config: {
          policyVersion: 2,
          workspaces: {
            main: { nodeId: "<paired-node-id>", remoteRoot: "/workspace" },
          },
          nodes: {
            "<paired-node-id>": {
              ask: "off",
              allowReadPaths: ["/workspace", "/workspace/**"],
              allowWritePaths: ["/workspace", "/workspace/**"],
              followSymlinks: false,
            },
          },
        },
      },
    },
  },
}
```

The example grants read and write access to the whole node workspace, including
hidden paths. Use a dedicated workspace with no unrelated private files. The
root entry permits operations on the directory itself; `/**` covers its contents.
The grants cover these operations:

| Operation                          | Required commands                                   | Paths covered by the example                                              |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| Workspace documents                | `file.fetch`, `file.write`, `dir.list`, `file.stat` | Owner documents and workspace files                                       |
| Memory file access and maintenance | `workspace.memory`                                  | Workspace root, Memory source files, and maintenance output               |
| Workspace Skills                   | `workspace.skills`, `file.create`                   | `skills`, `.agents/skills`, installation records, and source staging      |
| Input attachment staging           | `file.create`, `file.stat`, `file.fetch`            | `media/inbound/openclaw-staged-*` directories and their ownership markers |

To narrow the policy, retain the paths needed by each enabled operation. See
[Workspace Skill installation](#workspace-skill-installation) for installation
paths. Gateway-installed bundled, managed, and plugin Skills remain on the
Gateway; this mapping does not copy them to the node. Explicit additional remote
roots need their own grants. Do not pre-create the `openclaw-staged-*` directories;
OpenClaw creates and checks their ownership markers.

`policyVersion: 2` is required for these positive path rules. Without a matching
node policy, access is denied. `ask` defaults to `off`, and `followSymlinks`
defaults to `false`; both are explicit here. Memory and Skills need existing
path grants, so do not use `ask: "always"` for this setup.

The Gateway command allowlist, approved node command surface, and file-path
policy are separate checks. A command deny or saved node command restriction
still blocks access. See [Node command policy](/nodes/command-policy#command-policy).

#### Select execution separately

The storage mapping does not select a model or move shell execution. Choose the
harness setup separately:

- For a remote Codex app-server, use [Codex app-server policy](/plugins/codex-harness/app-server#app-server-policy).
  Set `appServer.remoteWorkspaceRoot` to `/workspace` and run the app-server
  against the same files as the paired node. WebSocket transport remains
  experimental and unsupported for production. The remote host needs Node.js
  for Codex's attachment reader.
- For native worker inference, use [Worker-local inference](/gateway/cloud-workers/native-inference).
  Its device profile, model credentials, worker admission, and managed workspaces
  have a separate lifecycle. Selecting that profile does not create this
  persistent file-node mapping.

Review each tool's execution host. The mapping does not redirect arbitrary
Gateway-local filesystem or shell tools. In Codex, use
[`codexDynamicToolsExclude`](/plugins/codex-harness/config-fields#config-fields)
to omit OpenClaw tools that should not be exposed. For example, exclude
`gateway_exec` and `gateway_process` when the model must not use Gateway shell
tools. Native Codex tools and other plugins retain their own permissions.

#### Verify the setup

Validate both configuration files with `openclaw config validate`, then apply
the Gateway configuration. After the command allowlist is active, reconnect the
node: restart its installed service with `openclaw node restart`, or stop and
run `openclaw node run` without `--pair` under the same account and state
directory to reuse its saved connection. On the Gateway, inspect
`openclaw nodes pending` and approve the updated command surface with
`openclaw nodes approve <nodeRequestId>` if requested. A Gateway configuration
reload alone cannot approve commands withheld during the earlier pairing.

Start a fresh session for the mapped agent. Check each boundary before using the
setup for normal work:

1. On the Gateway, run `openclaw nodes describe --node <paired-node-id>`.
   Confirm that the node is connected and exposes all seven commands above.
   Check pending approvals if a command is missing or unavailable.
2. In the Control UI agent file editor, read and update `AGENTS.md` for `main`.
   Confirm the change in `/workspace/AGENTS.md` on the node.
3. Put a distinctive entry in a node Memory source file. Use the agent's Memory
   read and search tools to check it after indexing. The existing Memory provider
   configuration still applies; a file mapping does not configure embeddings.
4. Add a workspace Skill under `/workspace/skills/<skill-name>/SKILL.md` and
   confirm discovery in a new session. If you use Skill installation, also test
   installation and removal through the normal Gateway workflow.
5. Send a small input attachment to the configured harness. Confirm that the
   turn can read its staged path under `/workspace/media/inbound/`. The canonical
   media reference remains on the Gateway.

If the node disconnects or the workspace service stops, mapped workspace access
fails instead of reading a Gateway-local copy. Restore the node connection and
retry. A `Workspace does not belong to this node` error means the node's configured
agent workspace does not match `remoteRoot`. Path-policy errors require the
specific missing grant; adding a command alone cannot fix them. Do not remove
the mapping to hide an outage, because that changes which files are authoritative.

### Workspace Skill installation

A paired workspace uses the native Skill installers for source publication,
source records, and ClawHub update and removal. Gateway keeps installation
policy and change hooks; the node keeps installed files and provenance. Local
workspaces keep their existing installation path.

Allow `workspace.skills` and `file.create`, read access to the workspace, and
write access to these paths (replace `/workspace` with the configured root):

- `/workspace/skills` and `/workspace/skills/**`, including native replacement staging.
- `/workspace/.clawhub/lock.json` and `/workspace/.clawdhub/lock.json` for installation tracking and its compatibility checks.
- `/workspace/.openclaw/skill-installs/**` for temporary source uploads.

The adapter opens an admitted node operation before uploading a bounded source
archive. The node extracts a private copy and waits for Gateway's installation
policy decision before publishing it. It retires staging when that operation
ends. Source transfers retain the file plugin's archive and extraction limits;
links and special files are rejected. A disconnected node fails explicitly.

ClawHub updates and removal retain native version and local-modification
checks. An installed Skill is discovered through the existing workspace catalog;
this does not add remote Skills to channel command menus.

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

If a saved file's metadata cannot be read, `dir_fetch` fails instead of reporting
a successful transfer with an incomplete manifest.

Directory fetch policy checks the source-tree descendants and then the archive
member identities admitted by the same bounded parser and policy planner used
for extraction. It does not use human-readable `tar` listings: admitted Unicode
and newline names retain their exact spelling, and producer-added AppleDouble
files are checked rather than hidden. Parent paths are checked even when the
archive omits directory headers. The 5000-descendant cap includes those implicit
directories, counting shared parents only once. A denied path rejects the whole transfer.
Resolved source path/device/inode binding, byte-count and SHA-256 verification,
link/traversal/collision checks, and extraction limits still apply. Malformed
archive headers and destination-platform filename restrictions still reject;
filenames are not truncated or repaired to make an archive pass.
