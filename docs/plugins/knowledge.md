---
summary: "Knowledge: an evidence-backed knowledge vault, memory provider, and Control UI explorer for OpenClaw agents"
read_when:
  - You want agents to remember decisions, preferences, people, and projects with retained source evidence
  - You are choosing between memory-core, memory-wiki, and Knowledge
  - You are enabling or configuring the bundled knowledge plugin
  - You are sharing one knowledge store between several agents
title: "Knowledge"
---

`knowledge` is a bundled plugin that gives each agent an evidence-backed knowledge
vault. Agents save pages, claims, and typed relationships as Markdown files with
retained source evidence. The Control UI has a read-only explorer for them. Knowledge
is also a memory provider: when it owns the memory slot, the agent's memory prompt,
recall, and pre-compaction flush use the vault.

Knowledge ships with OpenClaw but stays off until you select it as the memory
provider.

## How it relates to other memory plugins

Knowledge is a `kind: "memory"` plugin. Only one plugin owns
`plugins.slots.memory` at a time, so selecting Knowledge replaces `memory-core`
(or another memory plugin) as the active memory provider.

| Plugin                                      | Role                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `memory-core` (default)                     | `MEMORY.md` and daily notes, semantic and hybrid search, dreaming, `memory_search`/`memory_get`.                                                 |
| [`memory-wiki`](/plugins/memory-wiki)       | Companion plugin. Compiles a wiki beside the active memory plugin; does not own the slot.                                                        |
| [`memory-lancedb`](/plugins/memory-lancedb) | External memory provider with LanceDB vector search and auto-capture.                                                                            |
| `knowledge`                                 | Memory provider with typed records, mandatory evidence on claims, keyword retrieval, journaled writes, local Git history, and a native explorer. |

Knowledge does not use embeddings. Retrieval is keyword (SQLite FTS5) plus exact
identity lookup and structured date queries. Selecting Knowledge does not migrate,
change, or delete `memory-core` data. Switching back leaves the vault intact.

## Enable Knowledge

Select Knowledge for the memory slot:

```json5
{
  plugins: {
    slots: {
      memory: "knowledge",
    },
  },
}
```

Selecting the memory slot is enough. A bundled memory plugin selected by
`plugins.slots.memory` is enabled even without a `plugins.entries.knowledge`
entry, and even when `plugins.allow` does not list it. It stays off if plugins
are globally disabled, if `knowledge` is in `plugins.deny`, or if
`plugins.entries.knowledge.enabled` is `false`. When the slot points elsewhere,
the memory-slot gate keeps Knowledge disabled.

Slot changes reload the plugin runtime without a Gateway restart. Knowledge
declares `reload.turnHandover`, so a reload does not wait for running agent
turns: each turn moves to the new version at its next model step
([reload-safe plugins](/plugins/sdk-runtime#reload-safe-plugins)). Verify the
runtime registration and the live service:

```bash
openclaw plugins inspect knowledge --runtime --json
openclaw gateway call plugins.sessionAction --params '{"pluginId":"knowledge","actionId":"status","payload":{}}' --json
```

Open **Knowledge** in the Control UI sidebar. Native UI from enabled bundled
plugins does not need the **Custom plugin UI** Labs setting. The `knowledge_*`
tools appear after the tool catalog refreshes.

See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect)
and [Hot reload](/gateway/configuration/hot-reload).

## Configuration

All settings live under `plugins.entries.knowledge.config`. Every key is
optional.

```json5
{
  plugins: {
    slots: {
      memory: "knowledge",
    },
    entries: {
      knowledge: {
        config: {
          operatorRead: true,
          writesEnabled: true,
          stores: {
            personal: { label: "Personal", agents: ["main", "research"] },
          },
          maintenance: {
            enabled: true,
            schedule: "30 3 * * *",
            timezone: "America/Los_Angeles",
          },
        },
      },
    },
  },
}
```

| Key                    | Type     | Default           | Meaning                                                                                                                    |
| ---------------------- | -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `operatorRead`         | boolean  | `true`            | Let authenticated operators with `operator.read` (or higher) inspect stores in the Control UI and operator RPC.            |
| `writesEnabled`        | boolean  | `true`            | Allow agent writes. When `false`, write tools reject, the memory prompt omits save guidance, and no flush plan is offered. |
| `stores`               | object   | `{}`              | Named shared stores. Keys match `^[a-z][a-z0-9-]{0,47}$`. Agents not listed use their own isolated store.                  |
| `stores.<name>.label`  | string   | the store key     | Display name in the Control UI (1–80 characters). Not a path or identity.                                                  |
| `stores.<name>.agents` | string[] | required          | Agent IDs that use this store (at most 100). An empty list keeps the store without members.                                |
| `maintenance.enabled`  | boolean  | `true`            | Run the scheduled maintenance pass.                                                                                        |
| `maintenance.schedule` | string   | `"30 3 * * *"`    | Five-field cron expression for the pass.                                                                                   |
| `maintenance.timezone` | string   | Gateway host zone | IANA time zone for the schedule.                                                                                           |

`operatorRead` and `writesEnabled` are plugin-wide gates. Changes to
`plugins.entries.knowledge.config.stores` do not reload the plugin; Knowledge
applies membership changes in place.

## Stores and agent membership

Every agent has an effective knowledge store. By default each agent gets its
own isolated store. A named entry under `stores` assigns several agents to one
shared store. An agent can belong to at most one named store; an agent listed
twice is unavailable until the duplicate is removed, and is never resolved by
first match.

- Stores are created lazily on an agent's first authorized use. Inspecting a store
  in the Control UI never creates it.
- Tools take no store, agent, path, or scope argument. The store comes from the
  calling agent's host-resolved memory audience on every call.
- Removing a named store from configuration does not delete its data. The store
  stays in the inventory as unassigned.
- Shared stores record which agent published each revision, so authorship
  survives sharing.

Inside each store, owner-direct turns read and write the store's private
partition. Group and other conversation turns are confined to their own
conversation partition. Operators can manage membership from **Settings → Stores
& sharing** in the Knowledge page (requires `operator.admin`).

See [Stores and access](/plugins/knowledge/stores-and-access) for the storage
layout, authority table, and limits.

## Where Knowledge keeps data

Knowledge keeps all state under the Gateway state directory
(`~/.openclaw` by default, or `$OPENCLAW_STATE_DIR`):

```text
<state dir>/knowledge/
  registry.sqlite       # store identities, agent bindings, maintenance schedule
  registry.id           # registry sentinel
  stores/<vaultId>/
    state.sqlite        # journal, history, search index, Git queue
    vault/              # Markdown records, retained evidence, local .git
```

The location does not depend on how the plugin was installed. Back up the
registry, each store's `state.sqlite`, and its `vault/` directory together. A
Markdown-only or Git-only copy is not a complete backup.

## Writes and authority

- Agents publish through journaled operations with revision/hash preconditions
  and exact-retry semantics. A `published` receipt means files were written.
- Claims and relationships require retained, hash-verified evidence. Pages may
  omit it.
- Saved records are immediately available. There is no approval or acceptance
  step.
- Corrections, withdrawals, supersessions, and identity merges are explicit
  agent operations that preserve history. See [Corrections and merges](/plugins/knowledge/corrections).
- The Control UI is read-only. **Ask** sends change requests to the agent in a
  new chat instead of editing records.
- Operators cannot save knowledge through operator read access. Changing store
  assignments needs `operator.admin`.

## Tools

Knowledge registers 36 `knowledge_*` agent tools. Each tool acts only on the
caller's authorized store and partition.

| Area                  | Tools                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status and vocabulary | `knowledge_status`, `knowledge_ontology`, `knowledge_diagnostics`                                                                                   |
| Find and read         | `knowledge_lookup`, `knowledge_grep`, `knowledge_records`, `knowledge_record`, `knowledge_connections`, `knowledge_evidence_read`                   |
| Dates                 | `knowledge_timeline`, `knowledge_chronicle_day`, `knowledge_chronicle_since`, `knowledge_chronicle_last_seen`                                       |
| Remember and author   | `knowledge_remember`, `knowledge_save_page`, `knowledge_edit_body`, `knowledge_create_claim`, `knowledge_create_relationship`, `knowledge_annotate` |
| Evidence files        | `knowledge_attach_file`, `knowledge_attach`, `knowledge_attachment`, `knowledge_reconcile_evidence`                                                 |
| Ingestion             | `knowledge_publish_batch`, `knowledge_verify`, `knowledge_source_check`                                                                             |
| Lifecycle             | `knowledge_correct`, `knowledge_withdraw`, `knowledge_supersede`, `knowledge_merge`, `knowledge_unmerge`, `knowledge_relink`                        |
| Automatic recall      | `knowledge_recall`                                                                                                                                  |
| History and recovery  | `knowledge_history`, `knowledge_revision`, `knowledge_mutation`, `knowledge_resume`                                                                 |

See [Tools](/plugins/knowledge/tools) for inputs, limits, and pagination.

## Bundled skills

Knowledge ships nine skills. They are agent workflows over the tools above, not
an autonomous ingestion engine.

| Skill                           | Use                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `knowledge-automation`          | Create and verify scheduled ingestion through the host scheduler with a retained authorized worker. |
| `knowledge-capture`             | Save decisions, preferences, facts, and short notes with attribution and readback.                  |
| `knowledge-claim-consolidation` | Review and consolidate claims: unlinked, on one page, or about one subject; supersede snapshots.    |
| `knowledge-correct`             | Correct or withdraw exact records and inspect affected knowledge.                                   |
| `knowledge-entities`            | Resolve and enrich people, companies, projects, and concepts with sourced profiles.                 |
| `knowledge-ingest`              | Ingest documents, articles, and conversations; learn lessons from sets of sources (`/learn`).       |
| `knowledge-meeting-ingest`      | Ingest meeting transcripts with attendee enrichment, decisions, commitments, and chronology checks. |
| `knowledge-recall`              | Answer from saved knowledge with inspectable citations. Read-only.                                  |
| `knowledge-source-ingest`       | Incrementally ingest enumerable sources with snapshot manifests and diffing.                        |

See [Ingestion workflows](/plugins/knowledge/ingestion).

## Control UI

The **Knowledge** page has Recent and Browse views, keyword Search, entity pages
with linked claims and evidence, typed connections, retained originals, and file
history. **Scribes** starts and controls [scribes](/plugins/knowledge/scribes).
**Settings** holds Stores & sharing, Vocabulary, Vault status, and
Maintenance. A **Knowledge** chat side panel lists the records an agent found,
read, or changed in the current conversation.

See [Control UI](/plugins/knowledge/control-ui).

## Local Git history

When writes are enabled and the `git` executable is available, Knowledge keeps a
local Git repository inside each store's vault. It commits each publication with
its retained evidence and checkpoints observed external edits. No remote, GitHub
account, or opt-in is needed. A failed Git step never undoes a saved record.

See [Local history](/plugins/knowledge/local-history).

## Scheduled maintenance

A daily pass (03:30 Gateway host time by default) links claims that
`knowledge_remember` saved without a subject to the one entity page they name.
It never calls a model or creates pages. It runs only while `writesEnabled` is
`true`. It uses the plugin service scheduler, not OpenClaw automations.

See [Maintenance](/plugins/knowledge/maintenance).

## Scribes

The **Scribes** tab starts conversations that keep a store up to date on their
own: consolidating unlinked claims after maintenance, learning from conversations
once or daily, and importing Memory once. Each follows a bundled skill; ongoing
scribes schedule themselves as OpenClaw automations.

See [Scribes](/plugins/knowledge/scribes).

## Capabilities and limits

| Capability                                               | Status                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| Scoped listing, evidence inspection, ontology validation | Implemented                                                       |
| Pages, claims, relationships, entity metadata            | Implemented through agent tools; journaled with retry recovery    |
| Revision/hash preconditions, receipts, history           | Implemented                                                       |
| Keyword retrieval and exact identity lookup              | Implemented (SQLite FTS5)                                         |
| Structured date queries                                  | Implemented                                                       |
| Original source file attachments                         | Implemented; chunked upload/download, no evidence-count cap       |
| Correction, withdrawal, supersession, identity merge     | Implemented as agent-only, history-preserving operations          |
| Local Git history                                        | Automatic when Git is installed and writes are enabled            |
| Interrupted-write recovery and conflict retention        | Implemented; not a complete backup/restore protocol               |
| Read-only Control UI                                     | Implemented; no direct write controls                             |
| Scheduled claim relink                                   | Implemented, on by default                                        |
| Embeddings / semantic search                             | Not implemented                                                   |
| Media extraction, OCR, transcription                     | Not implemented; originals are retained and downloadable          |
| Connectors, sync daemons, ingestion scheduler            | Not implemented; use `knowledge-automation` with host automations |
| Git remotes, push, or sync                               | Not implemented                                                   |
| Full backup/restore                                      | Not implemented                                                   |

Knowledge does not replace workspace bootstrap files, dreaming, standing intents,
`memory-core` tools and CLI, or the file-oriented Memory UI.

## Moving from a linked or path install

Earlier releases shipped Knowledge as a separate package installed with
`openclaw plugins install` or loaded from a checkout. That copy can still take
precedence over the bundled one:

- A path in `plugins.load.paths` always wins over a bundled plugin.
  `openclaw plugins install --link` adds such a path and also creates an install
  record.
- A tracked global install from `openclaw plugins install` wins over a packaged
  bundled copy. A bundled copy compiled inside a source checkout wins over a
  tracked install.

If Knowledge is only listed in `plugins.load.paths` with no install record,
remove that path. The slot and `plugins.entries.knowledge` settings stay as they
are.

If Knowledge has an install record, uninstalling it also clears its settings.
`openclaw plugins uninstall` removes `plugins.entries.knowledge.config`, resets
`plugins.slots.memory` to `memory-core`, and leaves an
`plugins.entries.knowledge.enabled: false` marker that also blocks the bundled
copy. Restore those settings afterwards:

1. Copy your `plugins.entries.knowledge.config` (including `stores`) somewhere
   safe.
2. Preview and run the uninstall. It also removes a linked install's
   `plugins.load.paths` entry, but does not delete the linked checkout.

   ```bash
   openclaw plugins uninstall knowledge --dry-run
   openclaw plugins uninstall knowledge
   ```

3. Re-enable the plugin to replace the marker, then set
   `plugins.slots.memory` back to `"knowledge"` and restore
   `plugins.entries.knowledge.config`.

   ```bash
   openclaw plugins enable knowledge
   ```

4. Confirm that the bundled copy is loaded:

   ```bash
   openclaw plugins inspect knowledge --runtime --json
   ```

Vault data and plugin state live under `<state dir>/knowledge/`, not in the
install directory, so switching copies does not move or reset them. Store
membership is read from configuration, so restore `stores` before agents use
Knowledge again. Until then, agents from a named store use their own isolated
store, and a new empty one is created if none exists. The named store's data is
kept. See
[Discovery precedence](/plugins/manifest/package-json#discovery-precedence-duplicate-plugin-ids)
and [Uninstall](/cli/plugins/uninstall-and-update#uninstall).

## Related

- [Stores and access](/plugins/knowledge/stores-and-access)
- [Memory provider](/plugins/knowledge/memory-provider)
- [Tools](/plugins/knowledge/tools)
- [Records and ontology](/plugins/knowledge/records-and-ontology)
- [Retrieval and dates](/plugins/knowledge/retrieval)
- [Evidence files](/plugins/knowledge/evidence)
- [Ingestion workflows](/plugins/knowledge/ingestion)
- [Corrections and merges](/plugins/knowledge/corrections)
- [Local history](/plugins/knowledge/local-history)
- [Maintenance](/plugins/knowledge/maintenance)
- [Scribes](/plugins/knowledge/scribes)
- [Control UI](/plugins/knowledge/control-ui)
- [Memory overview](/concepts/memory)
