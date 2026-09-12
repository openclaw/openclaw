---
summary: "Weekly Workshop collection review, its change semantics, and backup recovery"
title: "Collection review"
read_when:
  - You are enabling or debugging the weekly collection review
  - You need to know what a review can change and what it cannot roll back
  - You are recovering a Workshop skill from a retained collection backup
---

## Collection review

In `auto` mode, the Gateway maintains one weekly automation per agent. It is
a normal isolated agent turn: cron owns scheduling, cancellation, and run
history. `propose` and `off` disable these reviews.

The reviewer reads and edits the agent's Workshop directory with normal file
tools. Directory listings are paged to fit the selected model instead of putting
every file path into the initial prompt. The reviewer follows each continuation
before changing that directory.
Skill contents are review material, not active instructions. It keeps useful
procedures, simplifies bloated skills, consolidates overlap, and removes obsolete
files. Absence of use in the current run never justifies removal. Usage tracking
and experience review remain active; weekly cleanup does not receive a separate
usage table.

The file tools stay rooted at the Workshop directory. Shell commands use the
operator's existing cron execution and approval policy; enabling review does not
grant additional shell access. An approval-required policy can refuse unattended
shell commands; a full-access policy permits them. File discovery does not need a shell.

Reviews support the embedded runtime and CLI runtimes that declare instruction
isolation, disable their native tools, and use only the Gateway's restricted
OpenClaw tool set, including Claude CLI. These CLI reviews retain the host-selected instruction snapshot;
Workshop skill contents remain review material. OpenClaw carries the Workshop
file root and prepared sandbox to the mediated tools. Changing the CLI working
directory alone does not provide containment.

Runtimes without those guarantees, including undeclared CLI backends, the Codex harness, and
node-placed CLI execution, remain unsupported for rooted reviews and fail with
an explanation. If an enabled sandbox has
`workspaceAccess: "ro"` or `"none"`, the turn refuses to run rather than editing
a disposable copy. A writable sandbox uses the agent's Workshop directory.
Sandbox backends must support directory reads to provide shell-free discovery.
Bundled backends use their existing filesystem permissions for these reads.

### Changes and recovery

Collection review follows normal agent file-edit semantics. Completed edits
remain if a later step fails or the turn is cancelled. There is no collection-wide
transaction, post-turn scanner, automatic rollback, or separate review history
writer. This also prevents a failed review from restoring an old tree over
concurrent operator edits. Per-skill proposal validation, scanning, and apply
behavior described in [How Skill Workshop works](/tools/skill-workshop/how-it-works)
are unchanged.

The reviewer ends with a summary of changes and removal reasons, or why no change
was needed. Find it in the automation's run history. Reviews do not announce into
a conversation. Future sessions load changed skills; running sessions retain
their existing instruction snapshot.

Existing collection backups are preserved. The `restore_collection` action
can restore a retained backup from the previous review implementation, but new
reviews do not create collection backups. The `history` action reads those
historical review records; current results belong to automation history.
Restore refuses to overwrite affected skills changed after that backup.

### When an older backup cannot be restored automatically

Restore also refuses when it cannot completely read the included content in a
current result tree or its saved original, including content beyond sixteen path
components. This leaves the current skill files and retained backup intact. Older
backups may contain hashes that omitted deeper files, so deleting that content
from the current tree cannot make the backup verifiable. A skill dropped by the
cleanup can still be restored to its absent path, including deep support files.
Do not edit backup hashes or delete or flatten live files merely to make restore pass.

For operator-led recovery:

1. Pause writes to the agent's Workshop, including collection review, before comparing or restoring files.
2. Locate the backup under
   `<agentDir>/skill-workshop/collection-backups/<backup-id>/`.
   Its `manifest.json` identifies the affected Workshop-relative directories in
   `skillDirs` and `resultSkillDirs`.
3. Create a new private inspection directory outside the Workshop and state
   directory. Copy the entire backup directory, including `manifest.json` and
   all saved content, into it. Current backups use `skills/`; history-only imports
   use `history/workspace/`. Separately copy each existing affected current directory
   into a `current/` subtree, preserving its Workshop-relative path. Include hidden
   files and all nested content. If any file cannot be copied, stop rather than use
   a partial copy.
4. Compare the inspection copies to select the intended content. Keep the live
   tree and original backup unchanged during review, and retain unedited copies
   of both versions before carrying out any operator-approved recovery.

Retained legacy backups may instead live under
`<state-dir>/skill-workshop/collection-backups/<workspace-hash>/<backup-id>/`
and contain a `workspace/` subtree. Preserve that original layout in inspection
copies; do not rewrite the manifest to make an old backup look current.
