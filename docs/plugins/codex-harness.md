---
summary: "Run OpenClaw embedded agent turns through the official Codex app-server harness"
title: "Codex harness"
read_when:
  - You want to use the official Codex app-server harness
  - You need Codex harness config examples
  - You need explicit Codex runtime policy and fallback rules
---

The official `codex` plugin runs embedded OpenAI agent turns through Codex
app-server instead of the built-in OpenClaw harness. Codex owns the
low-level agent session: native thread resume, native tool continuation,
native compaction, and app-server execution. OpenClaw still owns chat
channels, session files, model selection, OpenClaw dynamic tools, approvals,
media delivery, and the visible transcript mirror.

During `initialize`, OpenClaw uses `capabilities.optOutNotificationMethods` to
suppress unused app-server notifications before they reach the transport and JSON
decoder. This includes cumulative turn diffs; file-change items still carry the
individual changes. The plugin's notification policy owns the exact method list.
Turn and item lifecycle, transcript, usage, approval, and catalog notifications
remain enabled. Some events whose payloads are not projected still carry progress:
MCP progress, streamed patch updates, reasoning section markers, and model metadata
keep native work from appearing stalled. Terminal interaction also informs process
cleanup. These notifications remain enabled. Older app-servers that do not recognize
the optional capability ignore it; the normal minimum-version check still applies.

The native session catalog keeps one resident index per Codex home, shared across
agents, working-directory filters, searches, and pages. Lists normally filter and page
bounded display rows in memory. They do not expire or restart native discovery
on the normal sidebar polling interval. The sorted view retains only eligible
display rows and is invalidated by resident row changes. Complete, unfiltered
queries reuse it directly; live status and workspace settings still apply per page.
This memory-only boundary is the local
resident query. The Gateway also reads session entries from its resident session-row
projection once ready; mutations can require exact-key refreshes before delivery.
Native adoption bindings still use their storage owner, and paired-node enumeration
can use network I/O. Previews remain limited to 500 characters;
native hydration and catalog pages remain limited to 64 rows each. Native `thread/list` has no bounded metadata projection, so wire JSON can still be
large. Complete catalog `thread/list` pages and metadata-only `thread/read` responses
up to 64 KiB are parsed and projected inline, avoiding worker startup for small
catalog refreshes. Larger responses use a worker owned by their app-server client.
Both paths apply the same projection. The stdout reader waits for the compact result
before delivering later responses or notifications. It transfers larger responses
as bytes, admits one worker task at a time, and pauses the transport while that task runs.
Incomplete-frame recovery stays in the worker, including when a malformed
frame hides its routing header until a later line; its decoded ID selects the catalog
projection and the captured row admission. Native control reads, normal streaming notifications,
and full-history reads keep their in-process decoder. Control reads preserve complete
native metadata, including model selection and direct-input capability; transcript
consumers require complete native raw items.
Each native list page contains at most 64 rows (less than 6 MiB of serialized
catalog metadata even at all field limits). Both paths apply the existing
prefix-first preview selector and 500-character display bound. Unchanged
background rows can reuse resident previews before delivery. Large native payloads
and their temporary objects stay in the worker. Metadata reads preserve exact
working directories and the native history paging mode.
Ephemeral threads are excluded as soon as native metadata acknowledges them, so
closing a short-lived helper cannot lose the exclusion while a background refresh is pending.
Recency, native position within exposed timestamp ties, and thread ID form the
stable ordering and opaque continuation key. Initial native positions preserve
the sub-second order that the protocol rounds to seconds. Unchanged rows keep
their positions across background refreshes, so existing cursors do not repeat
or skip them. Newly discovered or newly active rows receive fresh positions ahead
of an existing timestamp tie, preserving native order within each discovery batch.
An observed turn start also receives a fresh position when its recency falls in
the same exposed timestamp second as earlier activity.
If every earlier matching row disappears, backward navigation returns the first
remaining matching page. An empty known prefix retains forward continuation while
hydration is incomplete.

The retained window is not a discovery limit. Once a home reaches 20,000 retained
rows, recent unfiltered pages still use memory. Paging at the retained boundary,
working-directory queries, and title searches use authoritative native database-only
pages, including sessions absent from memory. Those requests can be slower. Each
fallback request retains at most one 64-row native page. Search, exclusion filling,
and any nested membership, status, or descendant reads share one 20-read budget
and the existing request deadline, including across scheduler pauses. The request
returns an opaque continuation when more discovery remains. Continue paging even
when a partial search page is empty. Native cursors preserve native ordering and
backward navigation. If a resident-to-native transition loses its anchor to a
concurrent native mutation, it reports a refresh error instead of silently ending
discovery. The snapshot remembers that the retained window may be incomplete.

Search and managed-session exclusion filling examine at most 20 resident pages
per request. If that limit is reached, the result retains an opaque continuation
cursor so the next request can find later visible matches. Queries served entirely
from the resident window perform no native reads; overflow discovery is the explicit exception.

Source backoff settles when the whole foreground fallback request completes,
including a bounded partial result with a continuation. Successful intermediate
pages do not clear earlier failures. A failed recovery probe advances the existing
backoff schedule; abandoning a request releases its probe without recording a new
host failure. Background hydration keeps its separate grouped attempt and can
walk the home to completion without consuming a foreground request's budget.

Explicit homes hydrate in the background when the plugin activates. An implicit
process home waits for an authorized catalog request. A home without a valid,
complete saved snapshot walks native `thread/list` pages once, yielding between
pages. Progressive lists serve resident rows immediately. If a local home is still
loading after 250 ms, the list returns that host as pending, preserving previously
displayed rows; the existing progress callback publishes its page or error when ready.
The page producer and publication remain owned by the list's background completion.
One-shot lists, host-specific lookups, and pagination wait for a usable native
page or confirmed empty inventory for at most five seconds (or the configured
app-server request timeout when shorter).
That single request budget also
covers loading saved state and draining earlier cache writes after a configuration
reload. A timed-out caller leaves the shared write drain running. Partial results carry an opaque continuation cursor;
a continuation that catches up with discovery waits for the next page within its
request budget. If discovery is still pending at the deadline, the host reports a
loading error and asks the caller to retry. The shared hydration continues in the
background. Partial or invalid saved caches are rebuilt before their rows are
shown, and initial retries preserve positions already used in continuation cursors.
The index persists reconstructible display rows and file fingerprints through
plugin state in the OpenClaw SQLite database. A valid complete snapshot serves a
recent unfiltered page without a native request, including on remote app-servers.
Snapshot restoration waits for earlier cache writes, and mutations received during
restoration fence stale saved rows from publication. Background work then
reconciles changed files and native metadata. A
database-only native metadata walk recovers changes made while the Gateway was
stopped. A full safety walk repeats every 15 minutes, including renames, Git branch and other displayed metadata, and the selected rollout
path after a native revert. Metadata changes and explicit clears are applied even
when native activity timestamps do not change. Newer Gateway observations fence
older background pages. These coalesced background walks reuse previews for
unchanged rows and do not ask Codex to scan or repair rollouts. Requests over a
complete snapshot never wait for these refreshes. A local database-only response can omit existing files when
indexing is incomplete or unavailable, so omission alone does not remove a local
row; verified file disappearance and explicit lifecycle events own removal.
Loaded/active status has a separate memory-only lifecycle. For each thread, at most
64 native connections can support the same current status. Closing one connection
or receiving its `notLoaded` status withdraws only that connection's observation;
an unrelated helper cannot clear activity observed by another open connection.
Status resets to **Stored / activity unknown** after restart or when its final
observing connection closes, until fresh native events or metadata supply current
status. Overflow pages use this same source-owned status, and their native reads
cannot overwrite a newer observation received while the request was pending.
Late responses from a closed connection cannot restore its active status.
No native rollouts or transcripts are copied into the state database.
Live workspace and model-provider settings also stay in memory, with at most
64 supporting native connections per row. Settings notifications and successful
resume acknowledgements update this overlay immediately; both cwd filtering and
display use it, including overflow pages. When live cwd settings are present,
overflow discovery filters after applying them instead of relying on stored native
cwd. Native metadata refreshes cannot overwrite the overlay, and closing its
last supporting connection or receiving that connection's `notLoaded` event
restores the stored metadata. Resume publication uses
the response's current cwd, which can differ from the thread's persisted cwd.
For remote app-servers without local filesystem access, the saved snapshot is
available immediately and a background native walk reconciles changes made while
the Gateway was stopped or its app-server connection was unavailable. The full
15-minute safety walk reconciles remote membership and metadata.
Unchanged display rows reuse their bounded resident previews before delivery.
Unchanged rows are not rewritten to SQLite.

Native starts, metadata refreshes, renames, archives, deletions, and changed file
fingerprints coalesce an incremental native check on the next 30-second tick.
It reads database-only pages in descending recency order and stops after a whole
page leaves the resident metadata unchanged, or at the 20,000-row retained limit.
The comparison includes timestamps, selected path, fingerprint, and bounded display
metadata; exposed timestamp ties keep their existing ordering. An unvisited tail
is never treated as deleted. With no activity, ticks issue no native requests or
file scans between safety walks. These checks reuse the existing preview cache
after JSON decoding; they reduce wire parsing by requesting fewer pages.

Silent changes outside the checked prefix, including timestamp-preserving metadata
edits and remote deletions or archives, appear at the next successful full safety
walk. Local file disappearance is checked on the same cycle; native database
omission alone still cannot delete a local row. Safety cycles start 15 minutes
apart, subject to timer scheduling, in-flight work, and
scan/walk duration. A failed background check records its error and waits for new
activity or the next safety cycle, subject to source backoff. It does not retry on
every idle tick. File scans keep an independent deadline, so native failures
neither repeat the scan nor postpone its next check.
Notifications and acknowledged catalog actions continue to update rows immediately.

Native lifecycle notifications update affected threads, and successful catalog
archives immediately hide their rows. Turn starts and completions coalesce
single-thread metadata refreshes, so a running turn advances recency before it
finishes. When an observing client closes, queued reads against that client stop;
an interrupted read records that metadata recovery is deferred to the current
catalog owner. Observations do not keep retired clients alive. A startup scan and
the 15-minute stat-only safety scan discover external rollout changes; no
recursive filesystem watcher retains a directory inventory. The scan streams
directory entries and retains at most 20,000 file fingerprints while separately
checking the presence of resident paths. Only changed or
new files are read: at most 128 KiB each from the head and tail of a plain rollout,
or a bounded 128 KiB compressed head. A missing first-user preview stays missing
until a later change makes it discoverable. Native titles are preserved when a
rollout has no title. A bounded read that cannot reach the first user message
preserves its previously known preview. Immutable, unmodified rollouts cause no content reads.
File-only rows remain provisional until native metadata arrives. After native
publication, changed rollout headers cannot replace the selected workspace or
native display metadata and `updatedAt`. A changed selected file can refresh its
bounded first-user preview; a bounded read that misses it retains the known preview.
Explicit native empty previews clear the stored fallback. Empty/nonempty preview
transitions remain visible even within one exposed timestamp second. Scans advance
recency only from parsed turn-start facts. This authority flag survives SQLite restore;
obsolete cached rows without it are discarded and pruned in the background before
rehydration. Name, status, and live-settings observations have independent
ordering, so a newer file update can coexist with a concurrent rename. Older
native metadata responses cannot overwrite newer file updates or removals.
Interrupted updates and transient file-read failures remain eligible for the next scan, even when
file size and modification time stay unchanged.
Plain and compressed rollouts share the native logical `.jsonl` identity;
the scanner prefers the plain file when both representations exist.
Codex owns the selected rollout path. Retained files from an earlier revert
cannot replace the current session's path or metadata during a filesystem scan.

Each home retains at most 20,000 display rows, 20,000 live-status records,
20,000 live-settings records, 20,000 name records, and 20,000 scan fingerprints, matching the existing Codex
managed-thread ceiling; eviction drops the oldest archived rows first, then the
oldest remaining rows. Row eviction preserves independently bounded live status and
settings while their supporting native connections remain open. Eviction removes only cached metadata: older sessions remain
discoverable through native paging/search and readable by ID. Initial and full safety walks finish pagination, but rows beyond the
resident limit are discarded before native-response metadata projection or preview
sanitization. The native page size stays 64, and pagination continues to completion.
At most 20,000 detached native cursors are remembered during a walk.
The same archived-oldest row limit applies when restoring a complete snapshot.
Incomplete snapshots still cannot establish a pageable native prefix.
Plugin state also has its shared capacity limit. Persistence failure
leaves the live resident view available and is logged; a missing complete
snapshot rebuilds on restart. The derived cache adds no database schema-version
change. A snapshot read failure invalidates durable completeness for that index
lifetime; native hydration remains available in memory, and the next successful
restart enumerates and prunes unread stale keys. The cache does not
alter native session files, update migrations, or rollback.
Exact-thread requests use fresh native metadata. Every remote eligibility check,
including a resident cache hit, verifies authoritative non-archived membership because native `thread/read` can return
archived threads. These checks use the existing request deadline, without a retained-row
or page-count cutoff; paired-node exact lookup follows continuations under its existing deadline.
Gateway aggregation only coalesces concurrent requests, so completed aggregate
responses cannot delay the next poll's view of resident changes.
While delivery waits for fresh identity facts, progress keeps the latest update
for each selected catalog and observed host. It emits separate one-host frames;
retained progress scales with distinct hosts, not with the number of updates.

The row and bookkeeping limits are independent per home. Thread identifiers are
limited to 256 UTF-16 code units, paths and working directories to 4,096, display
metadata and previews to 500, status to 64, and active flags to 16 entries of 128.
Retained strings are detached from larger native input strings. Preview decoding
keeps its existing UTF-8 replacement behavior. Event scheduling and concurrent
single-thread projections each admit at most 20,000 operations; mutations,
obsolete cleanup keys, and pending persistence writes also have 20,000-entry
ceilings. Persistence reserves one additional complete-marker operation and one
in-flight write. Overflow preserves already-admitted writes, invalidates the
complete marker, and logs a warning; resident queries remain available. Periodic
reconciliation continues to refresh native metadata after an overflow.

These are payload limits, not a promise about total JavaScript heap or Gateway
RSS. With every string at its maximum length and two bytes per UTF-16 code unit,
the following conservative capacities apply. The 490 column assumes 490 occupied
entries in each named structure; a home with 490 current rows can still have
20,000 historical field or queue entries.
With those independent field and scan-path indexes full, settled string payload is
bounded by 472.164 MiB for 490 current rows, or 936.165 MiB for 20,000 rows. These
figures exclude active work and object/engine overhead.

| Retained string payload                        | 490 entries | 20,000 entries |
| ---------------------------------------------- | ----------: | -------------: |
| Display rows (12,469 code units each)          |  11.654 MiB |    475.655 MiB |
| Name, status, and settings records together    |   7.454 MiB |    304.260 MiB |
| One scan-path generation                       |   3.828 MiB |    156.250 MiB |
| Native thread DTOs pending projection          |  13.569 MiB |    553.856 MiB |
| Mutation identifiers                           |   0.239 MiB |      9.766 MiB |
| Cleanup or persistence keys (512-byte ceiling) |   0.479 MiB |     19.531 MiB |

A native walk and file scan can each retain an older row snapshot, adding at most
two row generations. Pending persistence can retain another row generation plus
one in-flight row. An active event projection can temporarily hold two bounded native DTO
generations and one projected row. File currency retains the previous and
new fingerprint generations plus presence keys; arrays and maps share their
referenced row/string values. The native cursor set has its own 156.250 MiB
maximum string capacity even in a home with fewer rows. Status and settings each
retain at most 64 passive source references per entry (2,560,000 references across
both full indexes). Object, map, array, promise, allocator, and engine overhead,
transport buffers, and the separate managed-thread/provenance caches are outside
these string-payload figures.

The generic plugin-state `entries()` API decodes an entire namespace before the
catalog can validate or limit its rows. Its 1 MiB generic value limit permits
19.532 GiB of serialized values for 20,001 entries, before JavaScript expansion.
The resident limiter bounds the admitted result, not this predecode peak. Normal
catalog writes contain only the much smaller bounded row shape; resolving the
generic peak requires a paged state API.

Pasted text saved as a `.txt` attachment is extracted by OpenClaw and included in
the current turn as untrusted external content, subject to the existing file
extraction limits. Extracted attachments use the sender's filename in model context,
even when the stored or staged copy has a generated name. This also applies to
adopted and forked Codex sessions with locked model selection. Images continue
through Codex's native image input.

For an unsandboxed local Codex process with file-read permission, OpenClaw also
supplies verified paths to saved documents. Codex can process the complete file
when inline extraction is bounded. OpenClaw adds the paths to the admitted native
input without changing its canonical attachment references or transcript text.
If the path note cannot fit the native input budget, OpenClaw omits it and retains
the original request and inline attachment context.
JSON escapes keep mention characters in attachment metadata from selecting skills
or plugins while preserving the decoded filenames and paths.
Codex retains that input in its own native conversation history. The path note
identifies a file; later turns still use the existing execution and tool-policy
admission. This does not expand workspace-only policies or expose Gateway paths
to remote app-servers.

Remote Codex app-servers can run on a different machine from the Gateway. Set
`remoteWorkspaceRoot` to validate remote workspace attachment paths. OpenClaw
transfers authoritative attachment bytes over the existing app-server connection
using a fixed, no-shell `command/exec` reader. The reader rejects symlinks,
enforces file and response size limits before allocation, and stages immutable
Gateway-managed media before channel delivery without requiring a shared or
synchronized filesystem. Codex images are materialized directly from typed
app-server events. Saved-path-only images use the same bounded remote reader.
Uploads always use the Gateway's configured channel identity and request timeout.

Use canonical OpenAI model refs such as `openai/gpt-6-astra`. Do not configure
legacy Codex GPT refs. Put OpenAI agent auth order under `auth.order.openai`.
Legacy Codex auth profile ids and legacy Codex auth order entries are
repaired by `openclaw doctor --fix`.

With provider/model runtime policy unset or `auto`, the `openai/*` prefix alone
never selects this harness. OpenAI may select Codex implicitly only for an
exact official HTTPS Platform Responses or ChatGPT Responses route with no
authored provider request override. Valid model-scoped `params.fastMode` /
`params.fast_mode` values and valid cutoff keys are typed agent-runtime
controls, so they do not count as authored provider request params or select a
runtime by themselves. See
[OpenAI implicit agent runtime](/providers/openai/runtimes#implicit-agent-runtime).
If Codex owns auth before Platform versus ChatGPT routing is known, OpenClaw
still requires every candidate route to declare Codex compatibility. Native
auth ownership alone never bypasses that route check.

When no OpenClaw sandbox is active, OpenClaw starts Codex app-server threads
with Codex native code mode enabled (code-mode-only stays off by default), so
native workspace/code capabilities remain available alongside OpenClaw
dynamic tools routed through the app-server `item/tool/call` bridge. An
ordinary OpenClaw sandbox or restricted tool policy disables native code mode
unless you opt into the experimental sandbox exec-server path. The effective
tool profile must allow all native shell and filesystem capabilities: `coding`
and `full` do, while `messaging` and `minimal` disable the native surface. Agent
and provider profile overrides and explicit tool restrictions still apply.
When sandboxing disables the native surface, allowed shell commands remain available
through `sandbox_exec`. Denying `process` removes `sandbox_process` and background
continuation, while `sandbox_exec` runs to completion under the existing timeout,
sandbox backend, and workspace-access policy.

Sandbox turns also use these tools when Codex allows only managed hooks and cannot
install the native process-admission hook. OpenClaw selects this existing execution
path before preparing the tool catalog and prompt. Existing policies that require
other enforcing native hooks still require their normal preflight to pass.

The sandbox exec-server option does not bypass those tool restrictions. Node-backed
`remote-exec` on a paired device or cloud worker instead uses its
placement-owned environment without that experimental flag. A dedicated cloud worker with a completed project preparation keeps the bound workspace and `HOME` paths, so native commands can reuse setup caches. The node exec-server still uses a separate temporary `CODEX_HOME` for each connection. Ending the connection removes that Codex state and preserves the prepared project home.

Some placements require native execution. Node-backed `remote-exec` turns reject
a limited profile when they cannot run without native tools. A native-owned
attached Codex thread can also reject a restricted turn when applying the policy
would require replacing that externally owned thread. This can interrupt an
existing conversation after an upgrade. To retain a limited profile, use a
Gateway-managed conversation or runtime with a compatible execution environment.
If native shell and filesystem access is intended, the operator can choose
`coding` or `full`. Other explicit tool and sandbox restrictions still apply;
an explicit finite tool allowlist still blocks native execution. OpenClaw does
not broaden tool access or replace externally owned threads automatically.

Scheduled and other runtime tool allowlists use the same aliases, groups, and
wildcards as the OpenClaw harness, including `cron`, `group:runtime`, and `web_*`.
An explicit empty runtime allowlist disables tools. Independent restrictions
must all permit a tool before OpenClaw registers it with Codex.

Eligible native-shell turns also retain `gateway_exec` and `gateway_process`
as a distinct OpenClaw execution path. Use `gateway_exec` only when a command
needs OpenClaw-managed Gateway environment access, including Secret Store
agent-readable environment values or protected egress sentinels. It is pinned
to the Gateway host and follows OpenClaw exec policy. `gateway_process` uses the
existing per-session OpenClaw process scope for background follow-up. Prefer
Codex native shell for ordinary local work.

A native shell command can yield a session handle before it exits. When a
successful turn ends with that exact command still owned by the native thread,
its tool row records **Outcome unknown** and explains that the process is still
running. This is not command success or failure. Collect the retained handle
with the native process-wait tool to obtain its output and exit code. The
continuation records that result without rewriting the earlier turn's snapshot.
The existing unknown-outcome audit diagnostic remains; cancellation and a
command with no confirmed live owner retain their failure handling.

Stopping an active Codex run interrupts its turn. With the OpenClaw sandbox
exec-server, cleanup stops the concrete processes admitted by that turn and
preserves independent background work in the same reused thread. Each process
retains its original source until settlement, including after foreground
completion. Visitor Access expiry and revocation stop the guest's retained
processes without interrupting a later maintainer turn. Native command admission and subsequent
process input recheck the original source; cleanup remains available after
revocation.

Other native execution modes retain thread-wide background-terminal cleanup.
Other Codex threads and deliberately backgrounded `gateway_process` jobs are
unaffected.
If native terminal cleanup fails, the run reports an error instead of silently
claiming cleanup succeeded. Inspect that thread's running terminals before
starting more work. This uses Codex's terminal ownership. It does not guarantee
cleanup of commands that deliberately detach from that ownership.

With the default `tools.exec.host: "auto"` and no active OpenClaw sandbox,
Codex also receives `node_exec` when a connected node supports `system.run`.
Offline paired devices and devices without shell support do not expose this tool.
When a node is configured, that binding must resolve to an eligible node. Native shell
remains on the Codex app-server host and workspace
(Gateway-local for the default stdio deployment). `node_exec` selects the sole
connected node that supports `system.run`, or requires a name or id when several
are eligible. It keeps OpenClaw's node approval policy in force and waits for the
remote command to finish. Remote-node background follow-up is not available. If
a finite runtime allowlist disables native Code Mode and leaves the turn without
an execution environment, OpenClaw keeps its policy-filtered `exec` and
`process` tools available instead for direct, unsandboxed execution.

When `tools.exec.host: "node"` or `/exec host=node` makes the node the session
default, OpenClaw hides the Codex-native shell and exposes `node_exec` only while
the node target is eligible. If it is unavailable, reconnect the configured node
or explicitly change the exec host. OpenClaw does not silently fall back to the
app-server or Gateway machine.

`gateway_exec` is not exposed when an active OpenClaw sandbox, a node-default
execution policy, memory-flush restrictions, tool allow/deny policy, or
`codexDynamicToolsExclude` would make Gateway host access a bypass. Secret
Store environment values never enter the Codex app-server process, native
shell, sandbox exec-server, ACP children, sandbox exec, or node exec.

This Codex-native feature is separate from
[OpenClaw Code Mode](/tools/code-mode), a separate JavaScript runtime with its
own automatic per-model activation and explicit overrides. It has a different
`exec` input shape. For the
broader model/provider/runtime split, start with
[Agent runtimes](/concepts/agent-runtimes): `openai/gpt-6-astra` is the model
ref, `codex` is the runtime, and Telegram, Discord, Slack, or another
channel is the communication surface.

## Saved-account usage

The plugin's `codex.accountUsage` Gateway method accepts `agentId` and `profileId`.
It reuses `account/rateLimits/read` in a temporary local app-server with the
selected login, even when the normal harness uses a native home or remote server.
Each request fetches current quotas for the selected saved subscription login.
The request requires `operator.admin` and rejects changed or removed credentials.
Proxy launch arguments are rejected to avoid changing a shared daemon's login.

## Native subagent status

Native Codex subagents appear under their parent in OpenClaw's task view.
Their current execution, task result, and result delivery are separate facts.
An approval or input request shows what needs attention. A native mailbox wait
shows that the agent is waiting for messages; it does not invent a list of child
dependencies. Idle, interrupted, or unloaded native threads do not prove that
the delegated task succeeded. A resumed native turn clears the previous turn's
current tool activity while retaining the task identity.

Follow-up work after a native child has finished creates a separate task run on
the same Codex thread. Earlier results and their delivery status remain intact.
Each task's transcript links to the full native child conversation, including later follow-ups.
Interrupted work keeps its task identity when the native turn resumes.
If a recovered turn's end is still unknown, OpenClaw waits for native history or
an end event before deciding whether later work resumes that task or starts a new one.
Older tasks without enough native turn information remain unresolved instead of
borrowing another turn's result.

For Codex V1 follow-ups, OpenClaw retains a successful submission receipt with
the parent binding until it records the matching native turn as a task. This
allows recovery when the parent yields or the Gateway restarts before observing
the child turn. A receipt alone does not keep an idle native connection alive.
Observation follows the existing warm-thread lifetime; an unmatched receipt
remains available for later recovery. Resetting the parent or replacing its native connection
invalidates these receipts. Before downgrading OpenClaw, let pending native work
settle: older versions can read the binding but may discard its recovery receipts
when updating it.

Closing a native child applies to the assignment selected when the close starts.
OpenClaw waits for Codex to confirm that the child's runtime is absent before
marking unfinished work canceled; a delayed close cannot cancel a later assignment.
If confirmation is unavailable, the task asks you to retry the close request.
Native result receipts do not identify the child's turn. If an earlier result
is still being recovered or repeated identical results make a receipt ambiguous,
OpenClaw preserves the later pending delivery instead of risking a lost result;
this can cause an additional continuation.

Codex owns native subagent execution and controls. Follow up through the parent
session, which can use Codex's native collaboration tools. OpenClaw's task view
observes those children and delivers results after a parent yields. The native
foreground parent already receives completion messages, so OpenClaw does not
send another continuation for a result it has consumed. Explicit OpenClaw or ACP
delegation continues to use `sessions_spawn`.

For native Codex V1 agents, a completed `wait` result also records delivery to
the foreground parent. OpenClaw does not start another continuation for that
same child result after the parent replies.

## Requirements

- The official `@openclaw/codex` plugin installed. Include `codex` in
  `plugins.allow` if your config uses an allowlist.
- Managed Codex app-server `0.155.1`. The plugin ships and manages
  `@openai/codex` `0.155.1` by default, so a `codex` command on `PATH` does not
  affect normal startup. Explicit custom, remote, and macOS desktop-owned
  app-servers must report a parseable semantic version of `0.149.0` or newer.
  Newer versions continue with a compatibility warning and normal runtime
  validation.
- Node.js on the remote Codex app-server host when `remoteWorkspaceRoot` is set
  and cross-machine workspace attachments must be transferred.
- Codex auth through `openclaw models auth login --provider openai`, an
  app-server account already present in the agent's Codex home, or an
  explicit Codex API-key auth profile.

For auth precedence, environment isolation, custom app-server commands,
model discovery, and the full config field list, see
[Codex harness reference](/plugins/codex-harness-reference).

## Quickstart

Install the official plugin, then sign in with Codex OAuth:

```bash
openclaw plugins install @openclaw/codex
openclaw models auth login --provider openai
```

Enable the `codex` plugin and select an OpenAI agent model:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-6-astra",
    },
  },
}
```

If your config uses `plugins.allow`, add `codex` there too:

```json5
{
  plugins: {
    allow: ["codex"],
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

Plugin config changes apply automatically in the default hybrid reload mode.
See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).
If a chat already has a
session, run `/new` or `/reset` first so the next turn resolves the harness
from current config.

## Verify Codex runtime

Use `/status` in the chat where you expect Codex. A Codex-backed OpenAI
agent turn shows:

```text
Runtime: OpenAI Codex
```

Then check Codex app-server state:

```text
/codex status
/codex models
/codex binding
```

After installing or updating OpenClaw, explicitly verify the managed package
binary before cutover:

```bash
openclaw doctor --lint --only codex/managed-app-server --json
```

For an effective Codex route using the managed stdio app-server, this
default-disabled check resolves the platform-native executable and requires the
exact Codex version pinned by OpenClaw. It does not execute custom, remote, or
macOS desktop-owned app-servers.

`/status` reports the resolved OpenClaw Fast policy (`on`, `off`, or `auto`)
and the selected runtime. It does not report the upstream service tier actually
honored or returned for a completed request. `/codex binding` reports the
attached native thread and current model settings. `/codex status` reports
app-server connectivity, account, rate limits, MCP servers, and skills.
Neither Codex command is provider-response telemetry. `/codex models` lists
the live Codex app-server catalog for the harness and account. If `/status` is
surprising, see
[Troubleshooting](/plugins/codex-harness/troubleshooting).

## Luna Reserve and credit usage

Ordinary `gpt-5.6-luna` and Luna Reserve (`gpt-reserve`) are separate routes.
Selecting ordinary Luna does not consume Reserve merely because its quota has
capacity. Turning Fast off changes the requested service tier, not the model route.

OpenClaw currently reports the Reserve bucket when Codex returns it, but does not
implement the backend-authorized Reserve transition and recovery flow. Do not
force the hidden Reserve model or treat an unused counter as authorization.
Account and client eligibility remain backend decisions.

After included usage is exhausted, ordinary requests may consume credits under
your account settings. Check the provider’s usage and spending controls before
continuing high-volume automation. Account balances and quota percentages are
not per-request billing receipts; `/status` and `/codex binding` do not establish
the service tier or charge actually applied to a completed request.

## Where each section moved

Every section of the single-page version now lives on this page or on one of the
nine child pages below. The anchors from the single-page version still resolve here.

### Run Codex on another machine

[Run Codex on another machine](/plugins/codex-harness/placement) — Place Codex native execution on a paired device or a cloud worker.

- <a id="run-codex-on-a-paired-device"></a>[Run Codex on a paired device](/plugins/codex-harness/placement#run-codex-on-a-paired-device)
- <a id="run-codex-on-a-cloud-worker"></a>[Run Codex on a cloud worker](/plugins/codex-harness/placement#run-codex-on-a-cloud-worker)

### Codex routing and deployment

[Codex routing and deployment](/plugins/codex-harness/routing) — Choose which OpenAI routes select Codex and shape the deployment around them.

- <a id="routing-and-model-selection"></a>[Routing and model selection](/plugins/codex-harness/routing#routing-and-model-selection)
- <a id="deployment-patterns"></a>[Deployment patterns](/plugins/codex-harness/routing#deployment-patterns)
- <a id="basic-codex-deployment"></a>[Basic Codex deployment](/plugins/codex-harness/routing#basic-codex-deployment)
- <a id="mixed-provider-deployment"></a>[Mixed provider deployment](/plugins/codex-harness/routing#mixed-provider-deployment)
- <a id="fail-closed-codex-deployment"></a>[Fail-closed Codex deployment](/plugins/codex-harness/routing#fail-closed-codex-deployment)

### Codex harness configuration

[Codex harness configuration](/plugins/codex-harness/configuration) — Codex harness config map, restricted turns, project instructions, compaction, and long context.

- <a id="configuration"></a>[Configuration](/plugins/codex-harness/configuration#configuration)
- <a id="restricted-turns-and-ring-zero"></a>[Restricted turns and ring zero](/plugins/codex-harness/configuration#restricted-turns-and-ring-zero)
- <a id="project-instructions"></a>[Project instructions](/plugins/codex-harness/configuration#project-instructions)
- <a id="compaction"></a>[Compaction](/plugins/codex-harness/configuration#compaction)
- <a id="direct-api-long-context"></a>[Direct API long context](/plugins/codex-harness/configuration#direct-api-long-context)

### Codex app-server policy

[Codex app-server policy](/plugins/codex-harness/app-server) — App-server transport, approval posture, auth order, and environment isolation.

- <a id="app-server-policy"></a>[App-server policy](/plugins/codex-harness/app-server#app-server-policy)
- <a id="native-approval-audit-evidence"></a>[Native approval audit evidence](/plugins/codex-harness/app-server#native-approval-audit-evidence)
- <a id="auth-order"></a>[Auth order](/plugins/codex-harness/app-server#auth-order)
- <a id="scheduled-app-authority"></a>[Scheduled app authority](/plugins/codex-harness/app-server#scheduled-app-authority)
- <a id="environment-isolation"></a>[Environment isolation](/plugins/codex-harness/app-server#environment-isolation)
- <a id="local-testing-env-overrides"></a>[Local testing env overrides](/plugins/codex-harness/app-server#local-testing-env-overrides)

### Codex plugin config fields

[Codex plugin config fields](/plugins/codex-harness/config-fields) — Top-level and appServer config fields for the Codex plugin.

- <a id="config-fields"></a>[Config fields](/plugins/codex-harness/config-fields#config-fields)

### Codex commands and diagnostics

[Codex commands and diagnostics](/plugins/codex-harness/commands) — The /codex command surface, Fast mode controls, and local thread inspection.

- <a id="commands-and-diagnostics"></a>[Commands and diagnostics](/plugins/codex-harness/commands#commands-and-diagnostics)
- <a id="shared-fast-mode-and-codex-fast-mode"></a>[Shared Fast mode and Codex fast mode](/plugins/codex-harness/commands#shared-fast-mode-and-codex-fast-mode)
- <a id="inspect-codex-threads-locally"></a>[Inspect Codex threads locally](/plugins/codex-harness/commands#inspect-codex-threads-locally)

### Codex runtime behavior

[Codex runtime behavior](/plugins/codex-harness/runtime-behavior) — Dynamic tools, web search, image loading, turn liveness, and runtime boundaries.

- <a id="dynamic-tools-and-web-search"></a>[Dynamic tools and web search](/plugins/codex-harness/runtime-behavior#dynamic-tools-and-web-search)
- <a id="image-loader-ownership"></a>[Image loader ownership](/plugins/codex-harness/runtime-behavior#image-loader-ownership)
- <a id="turn-liveness-and-timeouts"></a>[Turn liveness and timeouts](/plugins/codex-harness/runtime-behavior#turn-liveness-and-timeouts)
- <a id="parallel-chats-and-thread-ownership"></a>[Parallel chats and thread ownership](/plugins/codex-harness/runtime-behavior#parallel-chats-and-thread-ownership)
- <a id="runtime-boundaries"></a>[Runtime boundaries](/plugins/codex-harness/runtime-behavior#runtime-boundaries)

### Native Codex state and features

[Native Codex state and features](/plugins/codex-harness/native-features) — Share native Codex threads, supervise sessions, and enable native plugins and Computer Use.

- <a id="share-threads-with-codex-desktop-and-cli"></a>[Share threads with Codex Desktop and CLI](/plugins/codex-harness/native-features#share-threads-with-codex-desktop-and-cli)
- <a id="supervise-codex-sessions"></a>[Supervise Codex sessions](/plugins/codex-harness/native-features#supervise-codex-sessions)
- <a id="native-codex-plugins"></a>[Native Codex plugins](/plugins/codex-harness/native-features#native-codex-plugins)
- <a id="computer-use"></a>[Computer Use](/plugins/codex-harness/native-features#computer-use)

### Codex harness troubleshooting

[Codex harness troubleshooting](/plugins/codex-harness/troubleshooting) — Symptoms and fixes for Codex harness selection, app-server, and memory problems.

- <a id="troubleshooting"></a>[Troubleshooting](/plugins/codex-harness/troubleshooting#troubleshooting)

## Related

- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Codex supervision](/plugins/codex-supervision)
- [Native Codex plugins](/plugins/codex-native-plugins)
- [Codex Computer Use](/plugins/codex-computer-use)
- [Agent runtimes](/concepts/agent-runtimes)
- [Model providers](/concepts/model-providers)
- [OpenAI provider](/providers/openai)
- [OpenAI Codex help](https://help.openai.com/en/collections/14937394-codex)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Copilot SDK harness](/plugins/copilot)
- [Plugin hooks](/plugins/hooks)
- [Diagnostics export](/gateway/diagnostics)
- [Status](/cli/status)
- [Testing](/help/testing-live#live-codex-app-server-harness-smoke)
- [ACP agents](/tools/acp-agents) — how ACP agents are configured and bound
- [ACP agents — setup](/tools/acp-agents-setup) — configuring this harness as an ACP agent
