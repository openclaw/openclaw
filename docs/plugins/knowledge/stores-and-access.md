---
summary: "Knowledge stores, storage layout, partitions, caller authority, and catalog limits"
read_when:
  - You are sharing a Knowledge store between agents
  - You need to know which caller can read or write which Knowledge records
  - You want a group chat to use an agent's private knowledge
  - You are backing up or inspecting Knowledge storage on disk
title: "Knowledge stores and access"
sidebarTitle: "Stores and access"
---

How Knowledge stores records, who can reach them, and what bounds apply. Part of
the [Knowledge plugin](/plugins/knowledge) guide.

## Stores

Every agent has an effective knowledge store: its own isolated store by default,
or a named shared store assigned in configuration.

```json5
{
  plugins: {
    entries: {
      knowledge: {
        config: {
          stores: {
            personal: { label: "Personal", agents: ["main", "research"] },
          },
        },
      },
    },
  },
}
```

- `stores` sets each agent's store. An agent in no named store uses its own
  isolated store.
- An agent listed in two named stores is unavailable until the duplicate is
  removed. Knowledge never resolves it by first match.
- A named store with an empty `agents` list remains in the inventory.
- Removing a named entry does not delete its storage. The store stays listed as
  unassigned and can be joined again.
- Agents removed from the host lose access; their stores are not deleted.
- Membership edits under `plugins.entries.knowledge.config.stores` do not reload
  the plugin. Knowledge applies them in place.
- Stores are created on an agent's first authorized use. Settings discovery,
  operator inspection, and status polling never create one.
- A store that existed and then lost its directory, manifest, or database is
  reported unavailable. It is never re-created empty.

Tools have no store, agent, path, or scope selector. Each call resolves the
store from the caller's host-minted memory audience.

### Manage stores from the Control UI

**Settings → Stores & sharing** in the Knowledge page lists each agent, its
store, and every known store including unused isolated stores and unassigned
named stores. Changes there require `operator.admin` and edit the `stores`
configuration:

- **Share this store** names the agent's existing isolated store and adds other
  agents. The store is renamed, not copied. Agents already in another named
  store switch to it.
- **Use shared store** moves an agent to an existing named store. Nothing from
  the agent's current store is moved or merged.
- **Use own store** returns an agent to its previous isolated store, or to a new
  empty one that is created on first use. Nothing from the shared store is copied
  or removed.

When an agent shares its isolated store, that store becomes the named store. If
that agent later chooses its own store, it gets a new empty store. There is no
hidden private copy.

The same page also lists **Conversation access** for the viewed agent; see
[Conversation access](#conversation-access).

## Conversation access

By default, a group or channel conversation reads and saves only its own
conversation partition. An owner can grant one conversation access to its
agent's private partition from **Settings → Stores & sharing → Conversation
access** (requires `operator.admin`, and the agent within the operator's role):

- **Can read** reads the private partition and cannot save. Saves fail with an
  error, and save guidance is left out of the conversation's prompt.
- **Can read and save** reads and saves the private partition, like an
  owner-direct turn.

Grants are keyed by conversation session key:

- Thread, topic, and other sessions whose key extends a granted key with `:`
  inherit its grant. The most specific grant wins. Spawned children already
  share their root conversation's audience.
- Read grants also include the
  [Knowledge index](/plugins/knowledge/memory-provider#knowledge-index) and
  automatic recall candidates.
- Read-and-save grants also allow approving automatic recall with
  `knowledge_recall`.
- There is no save-only grant. Saves run against the private partition, and
  their results would reveal existing private records to a conversation that
  cannot read them.
- Saves from a granted conversation are recorded in history with the writing
  agent, like any other save.
- Grants are Knowledge state kept in `registry.sqlite`, not configuration.
  A change applies immediately without a reload. A revoked or narrowed grant
  fails in-flight work at its next authority check and returns the
  conversation to its own partition.
- The page lists the viewed agent's group and channel conversations to choose
  from. Grants that match no known session are marked **No known
  conversation**. Knowledge decides access from the host-minted audience's
  session key, never from session rows.

Removing access stops future reads and saves. It cannot remove what the
conversation already retrieved.

## Storage layout

Knowledge keeps all state under the Gateway state directory (`~/.openclaw` by
default, or `$OPENCLAW_STATE_DIR`):

```text
<state dir>/knowledge/
  registry.sqlite             # store identities, bindings, assignment journal, conversation grants, maintenance schedule
  registry.id                 # sentinel: a missing or emptied registry needs recovery
  stores/<vaultId>/
    state.sqlite              # journal, history, search index, Git queue, Recent projection
    vault/
      vault.json              # store manifest
      .git/                   # local history, created automatically in writable mode
      private/
        ontology.yaml         # optional extension of the shipped ontology
        people/, projects/, … # page records
        claims/, relationships/
        artifacts/            # retained evidence for this partition
      conversations/<sessionId>/
        …                     # same layout, scoped to one conversation
```

Configuration is the authority for membership. The registry is the authority
for store identities, bindings, and recovery state. Store paths are registry
facts, never configuration. A store that a previous Knowledge release created
outside `stores/` keeps its original location, recorded in the registry.

`vault.json` is a strict JSON object owned by the store:

```json
{
  "format": "knowledge-vault-v2",
  "vaultId": "11111111-1111-4111-8111-111111111111",
  "generation": 0,
  "publicationId": "22222222-2222-4222-8222-222222222222"
}
```

The manifest is bound to the store's `state.sqlite`, outside the editable vault.
Manifest identity, publication checkpoint, partition directory identity, and
authority are checked before and after each query. Identity mismatches and an
older vault paired with a newer database fail closed. A conflicting checkpoint is
never replaced automatically.

<Warning>
There is no complete backup/restore procedure. Back up `registry.sqlite`, each
store's `state.sqlite`, and its `vault/` directory together. The database holds
receipts, history, withdrawal safeguards, and session activity that cannot be
rebuilt from Markdown or Git.
</Warning>

## Partitions

Each store has a private partition and one partition per conversation.
Partitions are selected before traversal, ontology resolution, validation,
counts, references, evidence reads, or diagnostics. There are no
cross-partition links or artifact reads. The shipped ontology applies in every
partition; private ontology extensions do not apply to conversations.

Records carry a store-owned scope that must match their partition:

```yaml
scope:
  visibility: private
```

```yaml
scope:
  visibility: conversation
  sessionId: 33333333-3333-4333-8333-333333333333
```

Records with missing, invalid, or mismatched scope are withheld and never
relabeled. History records which agent wrote each revision, so a shared store
keeps each revision's author.

## Caller authority

| Caller                                             | Required trusted evidence                                                                                                                                           | Scope                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Control UI or operator RPC                         | Authenticated connection, host `operator.read` (or write/admin), `operatorRead: true`, the agent within the caller's role, and `operator.admin` on a shared Gateway | Private partition of the default agent's store, or of an agent selected in the Knowledge page |
| Operator changing assignments or grants            | `operator.admin`, and the grant's agent within the caller's role                                                                                                    | Store membership and conversation grants only; never knowledge edits                          |
| Agent, owner-private audience                      | Host-minted `owner-private` memory audience and current invocation guard                                                                                            | Private partition of that agent's store                                                       |
| Agent, conversation audience                       | Host-minted `conversation` memory audience with its session key and UUID, and invocation guard                                                                      | That session's conversation partition in the agent's store                                    |
| Agent, conversation audience with an owner grant   | The conversation audience above, and an owner grant covering its session key                                                                                        | Private partition of the agent's store for the granted reads or saves; otherwise as above     |
| Spawned child                                      | Root audience validated and delegated by the host                                                                                                                   | Same partition as the originating root                                                        |
| Missing or stale audience, sandboxed provider call | Insufficient authority                                                                                                                                              | Denied                                                                                        |

Operator browsing reads an agent's private partition. A named operator role
limits it to the role's agents. When several people share the Gateway, it also
requires `operator.admin`, the same owner status that gives session turns the
owner-private audience.

OpenClaw resolves direct-owner, conversation, and spawn inheritance and supplies
the resulting audience. Knowledge does not read session entries, inspect chat
metadata, or reconstruct spawn lineage. It matches owner grants against the
audience's session key and re-checks the audience and grants before and after
asynchronous work.

Agent writes use the same scope mapping as reads, except that a read-only grant
refuses them. Operator
read access cannot save. Cross-conversation recall, background host access, and operator browsing
of conversation partitions are not exposed.

## Runtime

Each physical store has one runtime: a storage worker thread, one serialized
operation lane, a filesystem watcher, and a Git queue. Every agent using the
store shares it. Vault scans, evidence checks, SQLite, and Git run in the
worker, off the Gateway main thread. Authorization stays on the main thread.
Evidence verification caches retain verdicts while file stamps remain unchanged;
artifact buffers and decoded text are released after the operation, including
when a citation fails validation.

Exact reads re-read files and record external edits, renames, and deletions on
the next query. Pending or conflicted accepted publications block ordinary reads
rather than serving a partial catalog. A stop, reload, or caller revocation
fences in-flight work.

## Limits

| Limit                                       | Value                                      |
| ------------------------------------------- | ------------------------------------------ |
| Filesystem entries per partition scan       | 100,000 (runaway guard, not a size budget) |
| Directory depth                             | 8                                          |
| Complete record size, including frontmatter | 5,000,000 UTF-8 bytes                      |
| Ontology and manifest file size             | 64 KiB                                     |
| Frontmatter nesting                         | 20 levels                                  |
| Diagnostics per response                    | 1,000 findings, with truncation reported   |

Original source files are hash-verified with streaming reads; see
[Evidence files](/plugins/knowledge/evidence). An incomplete scan fails instead
of returning a partial or empty result. File access rejects symlinks and
hardlinks.
