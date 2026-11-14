# Discord archived-thread CLI guidance

## Source and change

Base: `f4976c968539eda937ce3ffdaaa5146c55bcb1bd` from public upstream main.
The change is limited to the Threads section of `docs/cli/message.md` and the
existing thread-list option descriptions/value label in
`src/cli/program/register.message.ts`. Flags, parsed option names, defaults,
required argument counts and action behavior are unchanged.

The docs now explain:

- `--include-archived` selects public archives in the specified parent channel,
  replacing active listing rather than combining active and private scopes.
- `complete` describes exhaustion of that selected listing, not universal thread
  history. `source` and `query` identify the selected scope.
- The next archived page uses the actual returned `nextBefore` ISO 8601 timestamp
  as `--before`, rather than a message/thread id.
- A known thread id can support a bounded read under existing channel policy and
  provider access checks; it does not grant access to private content.

Source fidelity was checked against `listThreadsDiscord` and the threadList
result owner. Both match the previously inspected source snapshot at this base.
The provider's [public archived-thread contract](https://github.com/discord/discord-api-docs/blob/da52492ced82d375981c46618cc3e182daada9a2/developers/resources/channel.mdx)
confirms public scope and timestamp ordering/cursors. Separate private archive
routes and permissions are not added or recommended as a workaround.

## Actual CLI observation

Node `24.22.1`, pnpm `12.15.0`; independently installed frozen dependencies.
The maintained source launcher built its own CLI artifacts, then these commands
both exited 0 using an empty isolated OpenClaw home/state/config path:

```text
pnpm openclaw message thread list --help
pnpm openclaw message read --help
```

Selected literal thread-list help output:

```text
  --before <timestamp>  ISO 8601 nextBefore value from the previous archived
                        page
  --channel-id <id>     Parent channel id (required with --include-archived)
  --include-archived    List public archived threads in the parent channel
                        instead of active threads (default: false)
```

The read-help opposite retained:

```text
  --before <id>        Read/search before id (Matrix: nextBatch/prevBatch token
                       from a previous read)
```

These are author-captured CLI observations, not independent source-blind proof.
No thread-list/read action, Gateway request, live provider call, private archive
retrieval, send or model invocation was performed. Earlier fictional HTTP
adapter controls supply source context only and are not claimed as CLI or live
provider proof.

## Focused checks and scope review

- Targeted oxfmt check: both changed source/docs files pass.
- Targeted typed oxlint: `register.message.ts` passes.
- MDX check: `docs/cli/message.md` passes.
- Docs link audit: 16,481 internal links checked, zero broken links.
- `git diff --check` passes.
- Simplification pass retained one docs hunk and one command-specific help hunk:
  22 added documentation lines, 7 added/3 removed TypeScript lines, no tests or
  runtime logic. No generic read/search option text changes.

Current overlapping PR patches were inspected before editing: #185548 touches
CLI ownership/config preparation and the docs opening; #186893 touches the docs
Core table. Neither changes the Threads documentation or thread-list help hunk.
No owner contact or publication was performed. CI and exact-head review remain
separate coordinator gates; this local evidence does not claim they passed.

## Public-main integration requalification

The additive integration commit `5d2d5755ff16537c5c70b766d907726604065256`
retains original head `2b159cc1ef08aa4c56384ca2cb6bc121579d05ed` as its first
parent and public main `0566b7771956f0f5dcb1a1ce32a729e7c5f5d9e7` as its second.
Its tree is `bcff201bdf30dfe45926ce6709f56e2e64a9b5aa`; the diff from that main
contains only the original four source, documentation and proof files.

At this integrated source revision, Node `26.13.0` and the existing pnpm
`12.15.0` installation ran the following successfully:

```text
pnpm exec oxfmt --check docs/cli/message.md src/cli/program/register.message.ts
node scripts/run-oxlint.mjs --type-aware src/cli/program/register.message.ts
node scripts/check-docs-mdx.mjs docs/cli/message.md
node scripts/docs-link-audit.mjs
pnpm openclaw message thread list --help
pnpm openclaw message read --help
```

The link audit checked 16,482 internal links with zero broken links. Both help
commands exited zero with the literal option text shown above, using an empty,
isolated OpenClaw home, state directory and configuration path. The maintained
source launcher rebuilt its CLI artifacts. No live provider operation ran.

The public archive implementation and thread-list result owner are byte-identical
to the original source-fidelity snapshot: `send.messages.ts` blob
`76a057a97c64d994bd345ca30eadc921e6f677b6`, and
`actions/runtime.messaging.send.ts` blob
`6ef63587cd340778926d13a5317882f48ed717a4`, under `extensions/discord/src/`.
The proof-media placement check passed with zero candidate media and zero required
fixes. These are author checks; CI, comprehensive review, native ClawSweeper
review and human merge approval remain outstanding for the published head.
