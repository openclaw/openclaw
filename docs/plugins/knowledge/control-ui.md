---
summary: "The Knowledge page and chat panel in the Control UI: views, settings, page addresses, links in chat, and session activity"
read_when:
  - You are browsing a Knowledge vault in the Control UI
  - You want to link to a Knowledge record from chat or another page
  - You want to see which Knowledge records an agent used in a conversation
title: "Knowledge Control UI"
sidebarTitle: "Control UI"
---

The Knowledge page and chat panel. Part of the
[Knowledge plugin](/plugins/knowledge) guide.

The Knowledge UI is a read-only inspector, even when agent writes are enabled.
**Ask** starts a new chat with the selected agent and sends your request as its
first message, with the exact observed record ID, revision, and hash attached.
The dialog shows only the editable request. Native UI from an enabled bundled plugin
does not need the **Custom plugin UI** Labs setting.

## Knowledge page

Open **Knowledge** from the Control UI sidebar.

- **Recent** and **Browse** list records; **Search** runs keyword retrieval.
- Entity pages show linked claims with evidence, typed connections, references
  and backlinks, retained originals under **File details**, and revision history.
- **Activity & issues** shows validation findings and local Git checkpoint state.
- An agent selector chooses whose effective store to view. It changes only what
  you see; it does not change membership or create a store.

**Settings** has four sections:

| Section          | Shows                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Stores & sharing | Agents, their stores, and membership changes; see [Stores](/plugins/knowledge/stores-and-access#manage-stores-from-the-control-ui) |
| Vocabulary       | The effective ontology: page and relationship types, fields, counts, and examples                                                  |
| Vault status     | Store identity and status for the selected agent                                                                                   |
| Maintenance      | Schedule, next and last run, and per-store results                                                                                 |

Operator access needs `operator.read` (or higher) and `operatorRead: true`. A
named operator role limits browsing to its agents, and a Gateway shared by
several people requires `operator.admin`.
Store membership changes need `operator.admin`. The page shows only private
partitions; conversation partitions are not browsable.

Views refresh on change events, on reconnect, and every 30 seconds while
visible. When a refresh crosses to a different store, the page clears the old
store's results instead of showing them under the new label.

## Page addresses

The page stores its navigation in Control UI `p.*` query parameters:

- `p.agent` selects an authorized viewing context and `p.vault` pins the observed
  store identity. Neither grants access. If the agent now uses a different store,
  the page explains the mismatch instead of opening a record there.
- `p.record` is the stable record ID, so renames do not change the address.
- `p.view`, `p.section`, `p.kind`, `p.type`, `p.q`, `p.filter`, `p.history`,
  `p.origin`, `p.offset`, `p.upper`, `p.before`, and `p.back` keep the view,
  search, filters, settings section, and pagination. Invalid values reset to safe
  defaults.

Refresh and browser back/forward restore the addressed view. Expansion state,
scroll position, and unsent Ask requests are not part of the address.

## Links in chat

Agents cite saved records with inline Markdown links to the Knowledge page. For
a Control UI served at the origin root:

```text
[Title](/plugin?plugin=knowledge&id=overview&p.agent=AGENT&p.vault=VAULT&p.record=RECORD)
```

Values are URL-encoded observed identities: `agent` and `vault` from the current
scoped status, and the record ID from a read or verified save. The writing agent
(`writtenByAgentId`) is not the viewing scope. A known Control UI base path is
preserved; when the deployment or scope is unknown, agents fall back to a readable
title with the record ID. Links open the full page, not a source line. Saved page
bodies keep using portable wikilinks.

## Session activity panel

The **Knowledge** chat side panel lists records the agent found, read, or changed
in the current conversation. Open it from the host's side-panel controls. Each
card shows the title, action, and time. Filter All, Reads, or Writes, switch the
order, load earlier entries, and select a card for a read-only preview. **Open
full page** opens the record on the Knowledge page.

- Provenance comes only from host tool context: agent, session key, session
  incarnation, and tool-call ID. Tool inputs cannot set it.
- Every publication records one write event per affected record in the same
  transaction as its history. Retries do not duplicate events.
- Record reads, exact lookups, searches, record lists, and connection queries
  record the returned identities on a best-effort basis. Searches and lists show
  as Found or Listed, not as full reads. A logging failure never fails a read.
- Operator inspection, provider projections, evidence downloads, and
  revision-history reads are not recorded. This is not a security audit log.
- Events live in the store's `state.sqlite` and cannot be rebuilt from Markdown
  or Git. There is no backfill for older sessions and no retention pruning.
- The panel shows private-store activity, filtered by agent, session key, and
  incarnation, so a session reset does not mix activity. Withdrawn, removed, and
  dependency-hidden records are not shown. A preview shows current content, not
  the revision captured by the event.

The panel polls every 10 seconds only while it is visible, connected, and on the
newest entries. Browsing older entries is not interrupted by background refresh.
