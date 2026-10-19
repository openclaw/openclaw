# Workboard

Track agent work with boards and cards in the Control UI. Workboard provides a
dedicated page, navigation entries, session accessories, and dashboard widgets,
alongside tools for creating, assigning, and completing work. Cards can link to
agent sessions and retain notes, proof, and run history.

## Get started

Enable the bundled plugin and open the dashboard:

```bash
openclaw plugins enable workboard
openclaw dashboard
```

Open **Workboard** from navigation to create a board and cards. No
plugin-specific configuration is required. Agent tools remain subject to your
tool policy and workspace permissions.

Workboard tracks work on one Gateway. See the [Workboard guide](https://docs.openclaw.ai/plugins/workboard)
for card workflows, worker dispatch, and sharing boundaries.

Sessions board placement repair runs in the service background. Sessions board
operations wait for repair; unrelated Gateway connections can proceed. Repair
failures appear in plugin service health, and shutdown joins outstanding repair.

## Large boards

The Control UI loads cards and sessions in pages of 100. **Load more cards** and
**Load more sessions** extend the current view. Card search and filters, and the
Sessions board's agent filter, apply to loaded rows; the page displays this scope
while more rows are available. Dashboard widgets also disclose incomplete counts
and offer **Load more cards**, including cards not loaded yet. Load all cards
before reordering them. Session
people filters continue to apply to the complete authorized session population.

Gateway clients continue `workboard.cards.list` with the returned `nextCursor` as
`after` (the `{ position, createdAt, id }` object), and
`workboard.sessionsBoard.read` with its string `nextCursor` as `after`. Both omit
`nextCursor` on the final page. Sessions responses also include the total matching
session count. `sinceRevision` applies only to a first-page refresh. CLI card lists
follow all pages automatically. Pages reflect current owner state, so a refresh
reconciles cards or sessions reordered between requests; a missing session cursor
returns an explicit refresh error.

## Browser development

The browser UI uses Solid 2 and bundles its own renderer through the plugin
builder. Shared pickers, dialogs, and dashboards use the documented Control UI
SDK mounts; browser code does not import host UI internals. Rebuild assets after
browser changes:

```bash
node --import ./scripts/tsx.mjs scripts/build-plugin-control-ui.mts extensions/workboard
```

The browser has a dedicated typecheck configuration:

```bash
node scripts/run-tsgo.mjs -p extensions/workboard/browser/tsconfig.json
```
