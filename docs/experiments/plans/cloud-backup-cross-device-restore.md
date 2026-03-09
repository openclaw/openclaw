---
summary: "Plan: Add reliable personal user backups in two phases: cloud drive workspace backup first, encrypted full snapshots second"
read_when:
  - Designing cloud backup for OpenClaw state and workspaces
  - Planning cross device restore without turning the state dir into a sync folder
owner: "openclaw"
status: "draft"
last_updated: "2026-03-10"
title: "Cloud Backup and Cross Device Restore Plan"
---

# Cloud Backup and Cross Device Restore Plan

## Context

OpenClaw is local first today.

Mutable state is spread across a few local locations:

- `~/.openclaw/openclaw.json` for config
- `~/.openclaw/credentials/` for OAuth tokens, API keys, pairing stores, and channel auth
- `~/.openclaw/agents/<agentId>/sessions/` for session store files and transcript JSONL files
- `~/.openclaw/workspace` or a custom workspace path for agent memory and working files
- device and node pairing state under `~/.openclaw/devices/` and `~/.openclaw/nodes/`

OpenClaw already supports local backup archives through [`/cli/backup`](/cli/backup), and the docs
already recommend keeping the agent workspace in a private Git repository when possible. See
[`/concepts/agent-workspace`](/concepts/agent-workspace),
[`/install/migrating`](/install/migrating), and [`/help/faq`](/help/faq).

At the same time, OpenClaw intentionally warns against placing the state directory in iCloud,
Dropbox, OneDrive, Google Drive, or other sync folders because sync style replication can leak
secrets and create file lock or race issues. See [`/gateway/doctor`](/gateway/doctor).

This plan adds cloud backup and restore without changing that trust model.

## Audience and product stance

This is a personal user product first.

`Industrial grade` in this document means:

- backups are reliable and testable
- restore paths are explicit and safe
- data handling is conservative
- failure modes are observable

It does not mean the product should start with enterprise style setup complexity.

The roadmap should therefore prioritize:

- the lowest possible setup cost in `v1`
- one obvious default path instead of many storage choices
- a clear separation between lightweight workspace backup and full disaster recovery

## Goals

- Add first class encrypted cloud backups for OpenClaw state.
- Support full host restore on a replacement machine or server.
- Support safe cross device continuity for the gateway backed state.
- Keep the workspace Git recommendation intact.
- Avoid turning `~/.openclaw` into a multi writer replicated filesystem.
- Reuse the current local backup manifest and verification model where practical.
- Define a production ready operating model with clear storage, encryption, retention, and restore
  requirements.

## Non goals

- Real time bidirectional sync of `~/.openclaw`.
- Conflict free multi writer session merging between gateways.
- Restoring device private keys onto a different physical device by default.
- Replacing private Git backup for workspace only use cases.

## Design principles

- One writer: a single gateway state directory remains the source of truth.
- Backup, not sync: cloud storage stores immutable encrypted snapshots.
- Client side encryption: the backup service must not see plaintext tokens or transcripts.
- Layered restore: restore config, state, and workspace intentionally, not as a blind folder sync.
- Device trust stays device scoped: gateway state can move; device identities should not silently clone.

## Industrial grade baseline

An industrial grade OpenClaw backup design should target:

- `RPO`: default hourly snapshots, with support for tighter schedules later
- `RTO`: restore to a working gateway within 30 to 60 minutes for a normal deployment
- immutable snapshot history for the configured retention window
- separate backup file access and backup encryption concerns
- documented restore drills, not just backup creation
- clear operator visibility for backup freshness, failures, and last verified restore

These are product goals rather than hard runtime guarantees, but the architecture should optimize for
them from the start.

## Why not sync folders

Sync folders are a poor fit for OpenClaw state:

- credentials, pairing, and transcripts are sensitive
- session and pairing files are updated frequently and atomically
- multiple hosts writing to the same synced tree will create race conditions
- some state is host or device scoped rather than account scoped

The product should keep warning on synced paths and introduce cloud backup as a separate feature,
not as an exception to the existing warning.

## State classification

OpenClaw should classify persistent state into recovery tiers.

| Tier                          | Examples                                                                 | Cloud backup              | Cross device restore |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------- | -------------------- |
| Workspace memory              | `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, `memory/` | Yes                       | Yes                  |
| Gateway config                | `openclaw.json`                                                          | Yes                       | Yes                  |
| Gateway credentials           | OAuth tokens, API keys, pairing allowlists, channel auth                 | Yes                       | Yes, with caution    |
| Session history               | session store JSON, transcript JSONL files                               | Yes                       | Yes                  |
| Gateway pairing state         | paired nodes, paired devices, approved scopes                            | Yes                       | Yes                  |
| Pending ephemeral state       | pending pairing requests, locks, temp files                              | No by default             | No                   |
| Device local identity         | iOS, Android, macOS device identity private keys                         | Optional same device only | No by default        |
| Device local auth token cache | device scoped role tokens on the client                                  | Optional same device only | No by default        |

## Product shape

The feature should have two layers.

### Layer 1

Keep the current local archive flow:

- `openclaw backup export`
- `openclaw backup verify`

This remains the canonical local packaging format and the recovery primitive for manual workflows.

### Layer 2

Add cloud snapshot commands on top of the local archive model:

- `openclaw backup run`
- `openclaw backup list`
- `openclaw backup restore`

The cloud feature should write encrypted snapshots plus a small local index into a backup folder,
not raw folders.

## Product roadmap

OpenClaw should ship backup in two user facing phases.

### V1

`V1` is the default path for personal users.

What it does:

- backs up the agent workspace only
- copies the workspace into a user selected cloud drive folder
- optimizes for a setup model users already understand from normal file backup tools

What it protects:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`
- other workspace files the user wants to keep in Git

What it does not protect:

- `~/.openclaw` gateway state
- credentials and channel logins
- session history and transcripts
- pairing state

Recommended default:

- `workspace` backup into an existing cloud drive folder such as `iCloud Drive`, `Google Drive`,
  `OneDrive`, or `Dropbox`

Advanced optional path:

- private Git repository for users who explicitly want version control semantics

This is the simplest credible backup path for personal users and matches how they already think
about file backup.

### V2

`V2` adds full disaster recovery.

What it does:

- creates encrypted full snapshots of gateway state plus workspace
- writes those snapshots as encrypted backup files into a user selected cloud drive folder
- supports full host restore on a replacement machine

Recommended default:

- encrypted snapshots in an existing cloud drive folder such as `iCloud Drive`, `Google Drive`,
  `OneDrive`, or `Dropbox`

This keeps `v1` easy while still giving OpenClaw a clear path to complete disaster recovery later.

## Storage model

### Recommended backend for V2

Use a user selected cloud synced folder for the encrypted backup file first:

- `iCloud Drive`
- `Google Drive`
- `OneDrive`
- `Dropbox`

Reasons:

- users already have these accounts
- setup is path based instead of credential based
- users already understand “a backup file in my cloud drive”
- the product can still keep state safety by writing a single encrypted archive file instead of
  syncing the live state directory

### Safety rule

The product should make one distinction explicit:

- allowed
  - writing a single encrypted backup archive into a cloud drive folder
- not allowed
  - putting the live `~/.openclaw` directory itself into a cloud synced folder

### What not to use as the primary snapshot store

- GitHub private repositories as the default for ordinary users
- raw syncing of the live `~/.openclaw` directory into iCloud, Dropbox, Google Drive, OneDrive,
  and similar sync folders
- databases or document stores that do not naturally model immutable binary objects

Those options are either too size constrained, too dangerous when used as live sync, or too
operationally awkward for personal user disaster recovery.

### Backup file layout

Each installation writes encrypted snapshot files into one selected backup folder.

Example:

```text
<cloud-drive-folder>/
  OpenClaw Backups/
    installation.json
    snapshots/
      2026-03-10T10-00-00Z-openclaw-backup.envelope.json
      2026-03-10T10-00-00Z-openclaw-backup.payload.bin
      2026-03-11T10-00-00Z-openclaw-backup.envelope.json
      2026-03-11T10-00-00Z-openclaw-backup.payload.bin
```

`installationId` should still be stable for one gateway lineage and survive host replacement after
restore.

### Data plane and control plane split

The implementation should keep three concerns separate:

- data plane
  - encrypted snapshot payloads and envelopes stored as files in the backup folder
- control plane
  - local scheduling, retention decisions, status history, and restore orchestration
- operator plane
  - human visible status, alerts, and audit logs

This makes it possible to support small local setups and enterprise managed setups with the same
backup artifact format.

## Encryption model

All cloud backups should be encrypted before being copied into the backup folder.

### Envelope

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-03-09T12:00:00.000Z",
  "snapshotId": "snap_...",
  "installationId": "inst_...",
  "cipher": "aes-256-gcm",
  "kdf": {
    "name": "argon2id",
    "memoryKiB": 262144,
    "timeCost": 3,
    "parallelism": 1,
    "salt": "..."
  },
  "wrappedDataKey": "...",
  "nonce": "...",
  "archiveSha256": "...",
  "archiveFormat": "openclaw-backup-tar-gz"
}
```

### Key sources

Support these sources in order:

- passphrase entered interactively
- `SecretRef`
- environment variable
- external key service integration in a later phase

The backup file location and the backup encryption key must remain separate concerns.

### Industrial grade key hierarchy

The long term key model should distinguish:

- `DEK`
  - a per snapshot data encryption key used to encrypt the archive payload
- `KEK`
  - a longer lived key used to wrap the DEK
- operator secret source
  - passphrase, secret ref, environment, or a later advanced key resolver

For the first production implementation, OpenClaw can derive or resolve a single logical key and
use it to wrap a fresh per snapshot `DEK`.

### Storage side encryption

### Key rotation

The system should support two distinct rotations:

- backup folder location changes without touching old snapshots
- backup key rotation by rewrapping future snapshots to a new `KEK`

Re-encrypting all old snapshots should be optional and handled as a maintenance workflow, not as a
normal backup path.

### Why client side encryption

This keeps the current trust boundary simple:

- OpenClaw operators control backup readability
- the cloud drive only stores ciphertext files
- restoring from leaked backup files still requires the backup key

### Threat model boundaries

This design protects against:

- leakage of backup files without the backup key
- cloud provider compromise that exposes only stored objects
- accidental deletion or overwrite when immutable storage controls are enabled

This design does not protect against:

- simultaneous compromise of the backup files and the backup key source
- malicious code already running on the gateway host at backup time
- operators intentionally restoring sensitive data to an untrusted host

## Backup contents

Cloud snapshots should build from the same logical asset planning as local backup.

Included by default:

- state dir
- active config
- credentials dir
- discovered workspaces

Excluded by default:

- lock files
- pid files
- temp directories
- pending pairing requests older than a short threshold
- local caches that can be rebuilt

`V2` should not start with user facing content selection. The default snapshot is the whole
recoverable gateway state plus workspace.

## Restore model

`V2` should support one normal restore path: full host restore.

### Full host restore

Use when replacing the gateway machine.

Restores:

- config
- credentials
- pairing state
- sessions
- transcripts
- workspace

Flow:

1. Stop the gateway.
2. Download snapshot metadata.
3. Verify integrity.
4. Decrypt into a staging directory.
5. Validate manifest paths and schema versions.
6. Replace the target state directory atomically where possible.
7. Run `openclaw doctor`.
8. Restart the gateway.

For industrial deployments, the restore pipeline should also produce a structured restore report
with:

- snapshot id
- archive and ciphertext hashes
- restore start and end timestamps
- restored targets
- doctor result
- operator supplied ticket or change reference if available

## Cross device restore model

The primary cross device story should be gateway continuity, not filesystem cloning across clients.

### Supported

- restore a gateway snapshot onto a new laptop, VM, or server
- reconnect the same chat channels after restore
- preserve sessions, transcripts, and pairings held by the gateway
- continue using a workspace from Git plus state from cloud backup

### Not supported by default

- cloning a mobile or desktop device private identity onto another physical device
- syncing device local auth caches across phones or laptops

### Reason

Device identity is used as a trust anchor. Copying that identity to another device silently weakens
the security model and makes device scoped approvals harder to reason about.

Instead, a new device should pair again against the restored gateway. This preserves:

- device provenance
- per device revocation
- operator visibility

## CLI proposal

The CLI should also be phased to match the product rollout.

### V1 commands

```bash
openclaw backup setup
openclaw backup status
openclaw backup run
```

`V1` should stay narrowly focused on helping the user initialize, run, and validate a workspace
backup into their cloud drive folder. It should not pretend to be full disaster recovery.

### V2 commands

```bash
openclaw backup run
openclaw backup list
openclaw backup restore <snapshot-id>
```

### Command semantics

#### `openclaw backup run`

Creates a local archive using the existing backup planner, encrypts it, copies it into the
configured cloud drive folder, and optionally applies retention.

Key flags:

- `--verify`: run local archive verification before encrypt and copy
- `--output <dir>`: keep the intermediate local archive in a specific directory
- `--json`
- `--snapshot-name <name>`: optional human label for operator visibility
- `--no-retention-prune`: copy only, skip retention cleanup

#### `openclaw backup list`

Lists snapshots visible in the configured backup folder.

Key fields in human and JSON output:

- snapshot id
- created at
- snapshot name if present
- archive size
- included asset modes
- openclaw version
- verified status

#### `openclaw backup restore`

Restores one snapshot into the local installation.

Key flags:

- `--from-file <path>`: restore from a previously copied encrypted bundle
- `--archive <path>`: restore from a local plaintext backup archive
- `--staging-dir <path>`
- `--force-stop`
- `--skip-doctor`
- `--restart`
- `--json`

### Restore safeguards

- refuse to restore while the gateway is running unless `--force-stop` is passed
- refuse to restore into a cloud synced state dir
- require explicit confirmation for full host restore in interactive mode
- always restore into staging first, never stream extract directly into the live state dir
- run the same archive verification checks used by `backup verify`
- emit machine readable failure classes and phase names for automation

## Config proposal

`V2` should start with a minimal configuration surface.

```json5
{
  backup: {
    target: "~/Library/Mobile Documents/com~apple~CloudDocs/OpenClaw Backups",
    encryption: {
      key: "${OPENCLAW_BACKUP_KEY}",
    },
  },
}
```

The backup encryption key should follow the same secret handling rules as other credentials and
should not be duplicated into the workspace.

### Config schema draft

This should be added under the top level `backup` key.

```ts
type BackupConfig = {
  target?: string;
  encryption?: {
    key?: SecretInput;
  };
};
```

### Deferred advanced config

The following should be deferred until the basic full snapshot flow is stable:

- custom retention tuning
- transcript exclusion
- alternate provider specific integrations
- `KMS` integrations

### Config field semantics

- `backup.target`
  - required for cloud drive style backup
  - points to a folder that OpenClaw owns for encrypted backup files
- `backup.encryption.key`
  - required for `push` and `restore`
  - should use existing `SecretInput` support so env and file refs work the same way as other secrets

### Validation rules

- `backup.target` is required for the first release path
- `backup.encryption.key` is required for any command that would encrypt or decrypt
- reject `backup.target` when it resolves inside the live state directory
- reject restore if the resolved local state dir is inside a synced folder even if the backup itself
  is valid

## Snapshot metadata model

The design should separate three layers of metadata.

### 1. Existing local backup manifest

This remains the manifest embedded inside the plaintext local backup archive produced by the current
backup system.

It describes:

- included source trees
- archive layout
- local backup options

### 2. New cloud snapshot envelope

This is the outer metadata for encrypted backup files.

It describes:

- snapshot id
- installation id
- encryption and KDF parameters
- plaintext archive hash
- ciphertext hash
- optional snapshot label

### 3. Backup folder index entry

This is the compact listing record used by `backup list`.

It should be safe to read without downloading the payload and should not include secrets or full
manifest contents.

Example:

```json
{
  "schemaVersion": 1,
  "snapshotId": "snap_20260309_120000_abc123",
  "installationId": "inst_main_123",
  "createdAt": "2026-03-09T12:00:00.000Z",
  "snapshotName": "pre-migration",
  "openclawVersion": "2026.3.9",
  "mode": "full-host",
  "includeWorkspace": true,
  "excludeTranscripts": false,
  "archiveBytes": 182340123,
  "ciphertextBytes": 182341024,
  "verified": true
}
```

## Installation identity

Cloud backup needs a stable installation identifier that outlives a single host.

### Proposed behavior

- create `installationId` on first successful `backup setup`
- store it in the state dir under a small dedicated file such as `~/.openclaw/backup/installation.json`
- restore should preserve this id by default for lineage continuity
- a user may explicitly rotate it with a later admin command if they want to fork backup history

This id is not a secret. It is a lineage identifier used for listing and retention scope.

## Retention policy

Retention should be deterministic and local decision based.

### Initial algorithm

- keep all snapshots from the last `keepDaily` distinct UTC days
- keep the most recent snapshot from the last `keepWeekly` distinct ISO weeks beyond the daily set
- keep the most recent snapshot from the last `keepMonthly` distinct year-month buckets beyond the
  daily and weekly sets
- apply `maxSnapshots` as a final hard cap after bucket selection

If retention deletes anything, it should only delete snapshot prefixes that are not selected by the
current policy and belong to the current installation id.

### Why not rely only on cloud drive version history

Cloud drive version history is too provider specific and too blunt for the first version. OpenClaw
needs operator visible selection rules and reproducible tests.

## Restore implementation detail

### Restore state machine

The restore pipeline should have explicit phases and checkpoint files in the staging dir:

```text
resolve-source
  -> download
  -> verify-envelope
  -> decrypt
  -> verify-archive
  -> extract
  -> validate-extract
  -> prepare-swap
  -> swap
  -> doctor
  -> restart
```

Each phase should write a tiny status file under the staging dir so interrupted restores are easier
to inspect.

### Staging layout

```text
<staging-dir>/
  envelope.json
  payload.bin
  archive.tar.gz
  extracted/
  checkpoints/
  logs/
```

### Swap rules

- never mutate the live state dir until `validate-extract` passes
- move the current live dir to a timestamped rollback dir first when possible
- move the extracted dir into place
- if swap fails mid-flight, attempt best effort rollback
- keep at most a small number of rollback dirs and document their location

### Validation before swap

- backup archive verifies successfully
- extracted config path is present for full host restore
- required session directories exist when restoring sessions
- permissions on sensitive files are tightened after extract
- no extracted path escapes the staging root
- the snapshot belongs to the expected `installationId` unless the operator explicitly allows lineage
  fork or adoption

## Same device identity export

The normal roadmap should not attempt device identity export. If this ever exists in a much later
phase, it should remain outside the default user experience and be treated as an advanced recovery
tool only.

## Operator visible status

Later status surfaces should expose:

- last successful cloud backup time
- last failed cloud backup time and phase
- latest snapshot id
- whether retention pruning deleted any old snapshots
- whether the current state dir is ineligible due to synced-folder placement
- last successful restore drill time
- active backup profile and storage target
- whether immutable storage protections are detected or missing

## Exit codes and failure classes

Cloud backup commands should return stable failure classes for automation:

- `2`: config invalid or missing required backup config
- `3`: secret resolution failed
- `4`: remote auth or connectivity failed
- `5`: verification failed
- `6`: decryption failed
- `7`: restore swap failed
- `8`: doctor failed after restore

Exact numeric mapping can still change, but the implementation should keep the failure classes
separate in code and docs.

## Scheduling and execution model

Industrial grade backup should be host initiated and single writer only.

### Scheduler requirements

- run on the active gateway host only
- skip overlapping runs if a prior backup is still active
- write a local execution record for each attempt
- jitter scheduled execution slightly to avoid fleet thundering herds in managed deployments
- allow operator forced ad hoc snapshots without disrupting the normal schedule

### Execution phases

Each scheduled run should record:

- plan
- package
- verify
- encrypt
- copy
- index-update
- retention
- finalize

This creates clean alerting and retry boundaries.

## Internal architecture

### Reuse existing modules

- local backup asset planning from the current backup command
- current backup manifest verification
- state path resolution
- doctor driven migration and repair after restore

### New modules

- `src/commands/backup-push.ts`
- `src/commands/backup-list.ts`
- `src/commands/backup-restore.ts`
- `src/backup/cloud/encryption.ts`
- `src/backup/cloud/retention.ts`
- `src/backup/cloud/restore.ts`
- `src/backup/cloud/scheduler.ts`
- `src/backup/cloud/status.ts`

### Restore pipeline

```text
backup file -> verify metadata -> decrypt -> local archive -> verify archive ->
extract to staging -> validate structure -> swap -> doctor -> restart
```

## Compatibility and migration

- cloud backup should wrap the existing local archive format rather than replace it
- older local archives should remain restorable offline
- restore should tolerate moved absolute source paths because the current backup manifest already
  records the original path for provenance, not for exact path replay
- follow up migrations belong in `openclaw doctor`, not inside ad hoc restore scripts

## Security considerations

- never write plaintext transcripts or tokens into the backup folder
- never store the backup key in the same remote system as an unprotected config file
- do not auto restore device private identities onto a different device
- keep synced folder warnings intact
- keep restore logs careful not to print secrets, raw tokens, or full decrypted manifest payloads
- require stronger operator acknowledgement when restoring credentials onto a new host

## Compliance and audit posture

Industrial operators often need evidence, not just features.

The design should make it possible to produce:

- backup success and failure history
- snapshot inventory by installation id
- restore reports with timestamps and operator identity where available
- proof that payloads are encrypted before being copied into the backup folder
- proof that snapshot retention and delete actions were policy driven

The first version does not need a full compliance framework, but the artifact and log model should
not block later `SOC 2`, internal audit, or regulated environment workflows.

## Failure handling

If restore fails:

- keep the existing live state directory untouched
- preserve the staging directory for operator inspection when safe
- emit a precise failure phase such as `copy`, `decrypt`, `verify`, `extract`, `swap`, or `doctor`
- allow retry from the copied encrypted bundle without forcing another snapshot creation

## Observability and alerting

The implementation should expose enough local status for future UI, CLI, and external monitoring.

Suggested metrics and status fields:

- backup duration by phase
- archive size and ciphertext size
- age of last successful snapshot
- consecutive failure count
- restore drill freshness
- retention delete count
- backup target and installation id

Suggested alert conditions:

- no successful backup within `2 x` the configured schedule interval
- verification failures
- repeated backup folder write failures
- restore drills older than the operator policy threshold

## Testing plan

- unit tests for encryption envelope encode and decode
- unit tests for backup folder layout and retention selection
- unit tests for restore refusal on synced state dirs
- integration tests for `backup run` into a temp backup folder inside a synced-drive-like path
- integration tests for `backup restore` into a temp home directory
- regression tests proving that a restored gateway preserves session history and pairing state
- tests that device local identities are excluded unless explicitly requested
- tests for scheduler overlap prevention and resumable failure reporting
- periodic manual or CI driven restore drills using real encrypted snapshots in a disposable target

## Phased rollout

### Phase 1

Ship `v1` workspace backup:

- workspace backup into a cloud drive folder
- cloud drive folder as the documented default
- setup and health checks focused on the workspace backup target
- clear product messaging that this is memory and workspace protection, not full gateway recovery

### Phase 2

Ship `v2` encrypted full snapshots:

- encrypted full snapshots copied into a cloud drive folder
- manual restore command
- cloud drive folder as the documented default
- retention policies
- scheduled snapshot creation
- status visibility for last successful backup

### Explicitly deferred

- selective restore modes for normal users
- device identity export or import across devices
- multiple first class cloud providers in the initial user experience

## Recommended operator guidance

- use a cloud drive folder for day to day workspace and memory backup
- use a private Git repository only when version control semantics are explicitly desired
- use encrypted cloud snapshots only when full disaster recovery is needed
- keep one local cold backup copy for worst case recovery
- do not place `~/.openclaw` in a sync folder
- treat restore drills as part of the operating procedure, not as an emergency only activity

## Open questions

- Should scheduled cloud backups run only on the gateway host or also from the macOS app UI?
- Do we want to support encrypted deduplicated chunk stores later, or keep full snapshot archives only?
- Should restore auto restart the gateway, or stop after `openclaw doctor` and require an explicit restart?
- Which small cache directories are worth excluding from the first version for speed without harming recovery?
