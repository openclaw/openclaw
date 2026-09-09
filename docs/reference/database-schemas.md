---
summary: "OpenClaw SQLite database locations, schema versions, integrity checks, and downgrade recovery"
read_when:
  - Diagnosing a newer database schema error
  - Checking database compatibility before an update or downgrade
  - Proposing a SQLite or persistent-store change
  - Preparing storage operations for another database backend
  - Recovering a database for an older OpenClaw release
title: "Database schemas"
---

OpenClaw stores control-plane state in a global SQLite database and agent data in one SQLite database per agent. Schema migrations run forward when a database opens. Older OpenClaw builds refuse databases written by a newer schema.

This page is an index. The reference is documented on seven pages, one per
reader job. Open the page that matches your task and stay there.

| Page                                                                                           | Read it when                                                                                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Database layout](/reference/database-schemas/layout)                                          | The two database roles, their on-disk paths, and the tables behind individual features.                  |
| [Versioning contract](/reference/database-schemas/versioning)                                  | How schema versions are recorded, when a bump is required, and how updaters cross one.                   |
| [Per-person and companion storage](/reference/database-schemas/personal-data)                  | Personal GitHub connections, personal model accounts, and Apple companion delivery journals.             |
| [Storage changes and release preflight](/reference/database-schemas/storage-changes)           | Preparing for another backend, the material-change review checkpoint, and `openclaw database preflight`. |
| [Agent schema history](/reference/database-schemas/agent-schema-history)                       | Per-agent database schema versions, their changes, and their first releases.                             |
| [State schema history](/reference/database-schemas/state-schema-history)                       | Shared state database schema versions, their changes, and their first releases.                          |
| [Integrity, troubleshooting, and recovery](/reference/database-schemas/integrity-and-recovery) | Integrity checks, common database errors, and the supported downgrade recovery path.                     |

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as
`/reference/database-schemas#schema-bumps-and-older-updaters` still resolves. Each entry points at the
page that now holds the content.

- <a id="database-layout" />[Database layout](/reference/database-schemas/layout#database-layout)
- <a id="plugin-state-listing-index" />[Plugin state listing index](/reference/database-schemas/layout#plugin-state-listing-index)
- <a id="mentions-inbox" />[Mentions Inbox](/reference/database-schemas/layout#mentions-inbox)
- <a id="acp-replay-accounting" />[ACP replay accounting](/reference/database-schemas/layout#acp-replay-accounting)
- <a id="meeting-transcript-tables" />[Meeting transcript tables](/reference/database-schemas/layout#meeting-transcript-tables)
- <a id="meeting_transcript_sessions" />[`meeting_transcript_sessions`](/reference/database-schemas/layout#meeting_transcript_sessions)
- <a id="meeting_transcript_utterances" />[`meeting_transcript_utterances`](/reference/database-schemas/layout#meeting_transcript_utterances)
- <a id="meeting_transcript_summaries" />[`meeting_transcript_summaries`](/reference/database-schemas/layout#meeting_transcript_summaries)
- <a id="update-run-ledger" />[Update run ledger](/reference/database-schemas/layout#update-run-ledger)
- <a id="cloud-repository-workspaces" />[Cloud repository workspaces](/reference/database-schemas/layout#cloud-repository-workspaces)
- <a id="versioning-contract" />[Versioning contract](/reference/database-schemas/versioning#versioning-contract)
- <a id="schema-bumps-and-older-updaters" />[Schema bumps and older updaters](/reference/database-schemas/versioning#schema-bumps-and-older-updaters)
- <a id="profile-owned-skill-library" />[Profile-owned skill library](/reference/database-schemas/versioning#profile-owned-skill-library)
- <a id="personal-github-connections-and-publication" />[Personal GitHub connections and publication](/reference/database-schemas/personal-data#personal-github-connections-and-publication)
- <a id="personal-model-accounts" />[Personal model accounts](/reference/database-schemas/personal-data#personal-model-accounts)
- <a id="apple-companion-delivery-journals" />[Apple companion delivery journals](/reference/database-schemas/personal-data#apple-companion-delivery-journals)
- <a id="preparing-for-another-database-backend" />[Preparing for another database backend](/reference/database-schemas/storage-changes#preparing-for-another-database-backend)
- <a id="keep-operations-at-the-owning-store" />[Keep operations at the owning store](/reference/database-schemas/storage-changes#keep-operations-at-the-owning-store)
- <a id="preserve-the-data-and-concurrency-contracts" />[Preserve the data and concurrency contracts](/reference/database-schemas/storage-changes#preserve-the-data-and-concurrency-contracts)
- <a id="keep-engine-specific-capabilities-owned" />[Keep engine-specific capabilities owned](/reference/database-schemas/storage-changes#keep-engine-specific-capabilities-owned)
- <a id="review-checkpoint-for-material-changes" />[Review checkpoint for material changes](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes)
- <a id="preflight-a-target-release" />[Preflight a target release](/reference/database-schemas/storage-changes#preflight-a-target-release)
- <a id="agent-schema-history" />[Agent schema history](/reference/database-schemas/agent-schema-history#agent-schema-history)
- <a id="creator-namespace-migration" />[Creator namespace migration](/reference/database-schemas/agent-schema-history#creator-namespace-migration)
- <a id="participant-identity-migration" />[Participant identity migration](/reference/database-schemas/agent-schema-history#participant-identity-migration)
- <a id="state-schema-history" />[State schema history](/reference/database-schemas/state-schema-history#state-schema-history)
- <a id="state-schema-16" />[State schema 16](/reference/database-schemas/state-schema-history#state-schema-16)
- <a id="state-schema-15" />[State schema 15](/reference/database-schemas/state-schema-history#state-schema-15)
- <a id="state-schema-13" />[State schema 13](/reference/database-schemas/state-schema-history#state-schema-13)
- <a id="state-schema-11" />[State schema 11](/reference/database-schemas/state-schema-history#state-schema-11)
- <a id="state-schema-9" />[State schema 9](/reference/database-schemas/state-schema-history#state-schema-9)
- <a id="integrity-checks" />[Integrity checks](/reference/database-schemas/integrity-and-recovery#integrity-checks)
- <a id="troubleshooting" />[Troubleshooting](/reference/database-schemas/integrity-and-recovery#troubleshooting)
- <a id="why-you-cannot-go-back-after-updating-to-2026.7.2" /><a id="why-you-cannot-go-back-after-updating-to-2026-7-2" />[Why you cannot go back after updating to 2026.7.2](/reference/database-schemas/integrity-and-recovery#why-you-cannot-go-back-after-updating-to-2026-7-2)
- <a id="the-gateway-refuses-to-start-with-a-newer-schema-version-error" />[The Gateway refuses to start with a newer schema version error](/reference/database-schemas/integrity-and-recovery#the-gateway-refuses-to-start-with-a-newer-schema-version-error)
- <a id="a-database-is-quarantined-after-integrity-verification-failed" />[A database is quarantined after integrity verification failed](/reference/database-schemas/integrity-and-recovery#a-database-is-quarantined-after-integrity-verification-failed)
- <a id="downgrades-are-unsupported" />[Downgrades are unsupported](/reference/database-schemas/integrity-and-recovery#downgrades-are-unsupported)
- <a id="example-state-schema-13-to-12" />[Example: state schema 13 to 12](/reference/database-schemas/integrity-and-recovery#example-state-schema-13-to-12)
- <a id="example-state-schema-12-to-11" />[Example: state schema 12 to 11](/reference/database-schemas/integrity-and-recovery#example-state-schema-12-to-11)
- <a id="example-state-schema-11-to-10" />[Example: state schema 11 to 10](/reference/database-schemas/integrity-and-recovery#example-state-schema-11-to-10)
- <a id="example-state-schema-10-to-9" />[Example: state schema 10 to 9](/reference/database-schemas/integrity-and-recovery#example-state-schema-10-to-9)
- <a id="example-state-schema-9-to-8" />[Example: state schema 9 to 8](/reference/database-schemas/integrity-and-recovery#example-state-schema-9-to-8)
- <a id="example-state-schema-7-to-6" />[Example: state schema 7 to 6](/reference/database-schemas/integrity-and-recovery#example-state-schema-7-to-6)
- <a id="example-agent-schema-17-to-16" />[Example: agent schema 17 to 16](/reference/database-schemas/integrity-and-recovery#example-agent-schema-17-to-16)
- <a id="downgrade-recovery" />[Downgrade recovery](/reference/database-schemas/integrity-and-recovery#downgrade-recovery)
