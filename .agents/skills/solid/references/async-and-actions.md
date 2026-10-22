# Async reads and actions

Use these recipes when a rendering consumer needs asynchronous data or mutation
feedback. The installed `solid-js/CHEATSHEET.md` and installed types are the
executable contract. The upstream design is described in the Solid 2 RFCs for
[async data](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/05-async-data.md),
[actions](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/06-actions-optimistic.md),
[stores](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/04-stores.md),
and [control flow](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/03-control-flow.md).
The RFCs can describe newer behavior than our installed pin; check the types
before using a new option.

The reference domain is [cron presentation](../../../../ui/src/pages/cron/cron-page-presentation.ts).
Its existing plain TypeScript owners retain request admission, connection and
agent scope, generations, mutation ordering, revision conflicts, and recorded
outcomes. Solid owns readiness, keyed presentation, and temporary optimistic
values. A projection or action must never become a second Gateway authority.

## Read a Gateway-owned resource

An async memo returns a promise; its accessor reads the resolved value. There
is no `createAsync`, `.loading`, or `.error` property. Read dependencies before
the first `await`, and put all data-dependent rendering under its `Loading`.

For a domain that already admits reads imperatively, observe its request
receipt instead of sending the same RPC from a memo. Cron's existing refresh
path calls `loadCronJobsPage` and publishes the captured state and completion
promise. A page-lifetime memo consumes that receipt:

```ts
type ReadReceipt = { state: CronState; epoch: number; result: Promise<unknown> };
const [receipt, setReceipt] = createSignal<ReadReceipt | null>(null);

// The existing scope-change owner resolves/replaces this before publishing.
let presentationLifetime = Promise.withResolvers<void>();
function retirePresentation() {
  presentationLifetime.resolve();
  presentationLifetime = Promise.withResolvers<void>();
}
// Scope and connectionEpoch are narrowed memos over the existing owner.
const jobsRead = createMemo(() => {
  const state = scope();
  const epoch = connectionEpoch();
  ownerJobs();
  ownerJobsError();
  const admitted = receipt();
  return admitted?.state === state && admitted.epoch === epoch
    ? admitted.result.then(() => {
        if (!state.cronJobsSnapshotRevision && state.cronJobsError) {
          throw new Error(state.cronJobsError);
        }
        return state.cronJobs;
      })
    : Promise.resolve(state.cronJobs);
});

// In the existing imperative owner refresh path, outside the computation:
const state = currentCronState;
const epoch = gateway.epoch;
const result = runCronTask(loadCronJobsPage);
setReceipt({ state, epoch, result });
```

Capture state, connection epoch, and receipt before awaiting. Keep the read memo
at page lifetime and capture its current scope in the tracked phase. Nesting it
inside a replaced scope memo can hold the scope transition on the very child
being retired, leaving unrelated model and route updates stuck too. Keep initial
snapshots promise-shaped so first readiness uses the same async boundary.

The scoped presentation memo below owns its optimistic store and saving flag.
Replacing the owner or reconnecting creates a new presentation and disposes the old one.
An ID-keyed optimistic store alone is insufficient: a guess for `job-1` on the
old Gateway otherwise follows `job-1` onto its successor until the old action
settles. The epoch also prevents a same-client reconnect from awaiting its
retired request receipt.

The underlying owner still rejects stale cache publication and handles
transport cancellation. Async memos suppress superseded answers but do not
abort RPCs. Do not call a publishing owner command from a pure memo: it may
synchronously write a signal, and it can duplicate admission already owned by
the route, reconnect handler, or event coordinator.

If the owner instead exposes a pure asynchronous read operation, it can be
called directly: `createMemo(() => owner.readDetails(props.id))`. The owner
still owns the complete request identity and accepted result. Do not replace
an existing route loader or shared cache merely to change the syntax.

```tsx
<Errored
  fallback={(error, reset) => (
    <div role="alert">
      {formatUiError(error())}
      <button
        onClick={() => {
          page.actions.onRefresh();
          reset();
        }}
      >
        {t("common.retry")}
      </button>
    </div>
  )}
>
  <Loading on={scope()} fallback={<JobsLoading />}>
    <JobsTable jobs={jobsRead()} pending={isPending(jobsRead)} />
  </Loading>
</Errored>
```

`on={scope()}` re-arms fallback when the connection/agent/query identity
changes. It takes a reactive value, never `on={() => scope()}`. Omit it when
revalidation should retain the displayed content. It does not remount children.
Keep surrounding chrome outside the data-dependent slot. A broad memo that
reads `jobsRead()` before passing props into this boundary defeats that
boundary; pass an explicitly named accessor to the slot or read it in the
child. This applies to `isPending` too: it performs a real read, so place it
under the same boundary.

Keep an ordinary data read as well: `isPending` treats an errored expression
as not pending, so using only that probe can hide a failure from `Errored`.
For a retained list, `latest(jobsRead)` consumes the data/error while serving
the last resolved value during revalidation. An uninitialized read still
suspends into `Loading`; `latest` does not invent an initial value.
An already-rendered sibling also needs the correct scope dependency; otherwise
it can hold an earlier scope outside the newly re-armed slot.

`latest(scope)` deliberately displays the destination of a held transition.
Use it when the selected scope/loading affordance should advance ahead of the
old data, for example `on={latest(scope)}`. It does not mean last-good data and
does not establish mutation authority. Plain `scope()` is the default when
the old content should remain associated with the old selection until commit.

An owner may already record an error with a retry outcome. Keep that visible
contract; a resolved receipt is not proof the RPC succeeded. `Errored` handles
rejected async reads and render failures. Its `reset` recomputes errored reads;
it does not repeat an imperative owner request, so the receipt example also
dispatches the owner's refresh.

### Loading during an error retry

In rc.16, `Errored` retains its error fallback while a reset read is pending.
An inner `Loading` therefore cannot replace that fallback with a loading
affordance. When retry must show a spinner or skeleton, put `Loading` outside
`Errored` and re-arm it for that retry. Plugin consent observes its inspection
receipt because every inspection should show loading. Catalog discovery
observes the owner's recorded error clearing, alongside its selection scope:
retry shows placeholders, while a successful same-selection refresh retains
the existing cards and their controls. Its separate pagination button observes
each receipt because the retained cards sit outside that loading boundary.
Before the first result exists, catalog discovery also observes the browse
receipt: an initial request can start after the page has already rendered.

Choose `on` from that presentation contract; observing every receipt would
unnecessarily replace the catalog on an ordinary refresh. Keep the imperative
owner retry and `reset()` together, and test the held retry before resolving
it. Eventual success alone misses the retained-error behavior. An outer
`Errored` remains appropriate when keeping its error visible during retry is
the intended contract.

Keep accepted content outside `Errored` when failure should add an alert instead
of replacing that content. Catalog cards are siblings of the readiness/error slot.
When the owner's accepted result still answers the selected query, that slot reads
`latest(ready)` so a held background request does not also hold live installation
updates or park card-local popovers. New selections consume ordinary readiness and
show the existing loading fallback. Keep selection identity in the plain owner;
do not synchronize a second accepted-selection snapshot in the renderer.

## Mutate with an optimistic presentation

Use a generator action to retain the transition context across async work.
Keep admission and write settlement in the existing owner. Derive an
optimistic store from the owner's readable result; never write optimistic
values into its authoritative snapshot.

```ts
// Construct these inside a memo keyed by scope() and connectionEpoch().
const [jobs, setJobs] = createOptimisticStore(
  () => {
    ownerJobs();
    return state.cronJobs;
  },
  [],
  { key: "id" },
);
const [saving, setSaving] = createOptimistic(false);
// Return them together with state, epoch, and jobsRead from that memo.

const presentMutation = action(function* (
  view: ReturnType<typeof presentation>,
  pending: Promise<unknown>,
  retired: Promise<void>,
  expected: Pick<CronJob, "id" | "enabled">,
) {
  try {
    if (isCurrentPresentation(view)) {
      view.setSaving(true);
      view.setJobs((rows) => {
        const row = rows.find((row) => row.id === expected.id);
        if (row) row.enabled = expected.enabled;
      });
      // The server also chooses schedule/revision facts we cannot predict.
      affects(view.jobsRead);
    }
    // Consume the admitted operation even if its presentation retired.
    yield Promise.race([pending, retired]);
    if (isCurrentPresentation(view)) {
      // The admitted operation already reconciled the Gateway snapshot.
      void refresh(view.jobs);
    }
  } catch (error) {
    if (isCurrentPresentation(view)) {
      view.state.cronError = formatUiError(error);
      publishCronState(view.state);
    }
  }
});

async function toggle(job: CronJob, enabled: boolean) {
  const view = presentation();
  if (!isCurrentPresentation(view) || !canManageCron() || cron.cronBusy) return;
  const current = cron.cronJobs.find((row) => row.id === job.id);
  if (!current) return;
  const pending = runCronTask((state) => toggleCronJob(state, current, enabled));
  const retired = presentationLifetime.promise;
  // Let the owner's publication land before the action joins this tick.
  await Promise.resolve();
  return presentMutation(view, pending, retired, { id: current.id, enabled });
}
```

Start the plain owner's operation before the presentation action. Cron's
existing synchronous scope-change paths call `retirePresentation()` before
publishing a new owner, connection epoch, or panel/route intent; page teardown resolves the current
lifetime too. A pending presentation races this retirement against its admitted
operation. It may finish presenting before that retired operation settles; the
plain owner still records the actual write outcome. `Promise.race` consumes
late rejection as well as resolution.

Capture the current retirement promise per action, before its first yield or
microtask. Do not cache it in the state/epoch bundle: panel navigation can retire
presentation without replacing either, and later actions need the new lifetime.

This retirement must come from the synchronous scope owner. Solid parks old
reactive cleanup while an action is pending, so resolving from the presentation
memo's `onCleanup` is too late: the new scope's reads can remain held by the old
action. A microtask between owner publication and action invocation also does
not solve that lifecycle. Do not cancel an authoritative write or force a
production `flush()` to release presentation.

Each action captures its presentation before starting asynchronous work.
`isCurrentPresentation(view)` compares the captured plain state and epoch with
the owner's current state and Gateway epoch. Recheck before optimistic writes,
error publication, and refreshing a captured source: reconnect may already
have disposed that source. The admitted promise still needs a consumer when
its presentation retires. A rendering accessor such as
`() => presentation().jobsRead()` follows the current scope but is not itself
a refresh target; refresh the captured original Solid accessor.

This is a shortened version of the existing admitted cron mutation chain
(`toggleCronJob` plus its refresh/reconciliation). `ownerJobs` is a synchronous
memo over the owner snapshot; it avoids making the optimistic store itself an
async reader outside the table's `Loading` boundary. Pass the stable identity
into the owner; resolve its current plain job there rather than sending a Solid proxy as an authoritative revision.
Editing, removing, and running still use their existing owner commands,
including confirmation and conflict recovery. Optimism is useful for the
predictable enabled value; it does not justify inventing a successful delete,
save receipt, or next-run time.

The APIs have different jobs:

| API                                             | Purpose                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Optimistic store setter                         | Show the expected value temporarily; it does not make its slot pending.                                                  |
| `affects(source)` or `affects(record, "field")` | Mark facts the in-flight work will change but cannot predict. Values remain readable. Use the narrowest truthful target. |
| `createOptimistic(false)`                       | A co-written process flag for saving/disabled controls. It returns to false when the action settles.                     |
| `refresh(source)`                               | Re-run the actual Solid derivation and reconcile with its source.                                                        |

Do not infer saving from `isPending`: a mutation can be busy while an
optimistic slot is readable and not pending. There is no matching
`finally { setSaving(false) }`; the transition retires the optimistic flag on
success or failure.

Keep that optimistic dependency live in mixed owner/presentation affordances:
cron uses `saving() || owner.cronBusy`. Reading the plain busy fact first can
short-circuit the optimistic read just when the mutation begins.
Keep the flag out of aggregate props memos. Cron passes it as a separate JSX
prop: `<CronView {...viewProps()} busy={page.saving() || viewProps().busy} />`.
Only consumers of `busy` should join its optimistic presentation lane;
unrelated form and route props follow the ordinary owner snapshot.

`refresh` takes the actual Solid accessor or derived-store root. A wrapper
such as `refresh(() => jobsRead())` is not refreshable. A bare refresh asks
the same question quietly; call `affects` when it should read pending.
Yield its promise to keep the action alive until reconciliation settles.

**Refreshing a receipt observer does not send an RPC.** In cron, the mutation
owner already reloads the list, so refresh only reconciles presentation with
that accepted snapshot. In a domain whose derived read calls `owner.list()`,
refreshing that read invokes the owner's read again. Choose the existing
contract; never add a duplicate post-mutation fetch or a revision/ack state
machine just to hold the overlay.

`action` returns a promise. Native event dispatch does not await it and
`Errored` does not automatically catch its rejection. Consume the promise:
keep expected failures in the owner's existing visible error contract, and
route unexpected rejections into that same error operation or a split effect's
`error` callback. If a domain models an action result as an async memo, read
that memo under `Errored`. Do not silently discard rejections. Boundary reset
retries a read, not a mutation; an explicit retry-save button must invoke the
save action. Keep the user's draft on failure.

### Local action errors beside retained controls

When a component owns only a local operation's feedback, keep its rejected
promise as the outcome instead of copying the error into a signal. A narrow
`Errored` slot can show the failure without replacing the usable control:

```tsx
const [attempt, setAttempt] = createSignal<{ result: Promise<void> }>();
const outcome = createMemo(() => attempt()?.result.then(() => null), { loadingValue: undefined });
// The event handler records the action promise and consumes its rejection even
// if this component retires before the error slot observes it.

<Show when={!saving()}>
  <Errored fallback={(error) => <p role="alert">{formatUiError(error())}</p>}>{outcome()}</Errored>
</Show>;
```

Here the co-written optimistic flag already presents progress. The explicit
`loadingValue` lets the error observer read pending work without holding that
affordance. Hiding the error slot while saving also clears the old failure on
retry. Keep controls outside the slot, preserve the owner's admission and
retirement checks, and consume the action promise in the handler; the memo is
not a substitute for handling an event action's rejection. Chat speech and
skill-review Undo use this pattern. Clear the recorded attempt when its target
changes so a successor cannot inherit the previous operation's failure.

### Command errors without optimistic state

Some plugin commands already expose their busy state through a shared owner.
They need no presentation action merely to show an error. WhatsApp Settings
stores the admitted command's completion promise and reads it under `Errored`:

```tsx
const [completion, setCompletion] = createSignal<Promise<void>>();
const completed = createMemo(() => completion()?.then(() => null) ?? null);

<Loading on={completion()}>
  <Errored fallback={(error) => <CommandError error={error()} />}>{completed()}</Errored>
</Loading>;
```

Start the owner command in the event handler, publish its completion, and attach
a rejection consumer for work whose view is replaced or disposed. Preserve the
owner's cancellation and error-precedence contract. Each new completion replaces
the previous read, so an older failed refresh cannot overwrite a newer success.
Re-arm this narrow error slot on retry to clear the previous error immediately;
keep the controls outside it. A local error string written by each completion
would lose that ordering and require a second request-generation guard.

## Key a projection over an owner snapshot

Use `projectSource`/`projectOwner` for the synchronous owner adapter, then
`createProjection` when a local structured derivation benefits from identity
reconciliation. They solve different problems:

```tsx
const rows = createProjection(
  () => props.jobs.toSorted((a, b) => failureRank(b) - failureRank(a)),
  [],
  { key: "id" },
);

return (
  <For each={rows} keyed={(job) => job.id}>
    {(job) => <JobRow job={job()} />}
  </For>
);
```

`createProjection` returns a store, not an accessor. Returning a fresh list
reconciles by `id`, retaining the row presentation as server objects are
replaced or reordered. Read fields inside JSX/memos; a `For` callback body is
not a tracking scope. Avoid a writable mirror of the owner.

Cron consumes readiness in a separate render slot under `Loading`. The table's
projection only sorts the synchronous optimistic rows:

```tsx
const readJobs = () => {
  latest(jobsRead);
  return null;
};

return (
  <Loading fallback={<JobsLoading />}>
    {readJobs()}
    <JobsTable jobs={jobs} pending={isPending(jobsRead)} />
  </Loading>
);
```

Keep this read outside the row projection and table construction. A failed
first read can recover through `Errored` without leaving the projection's
initialization errored. The table also retains its DOM identity through an
optimistic transition; a readiness `Show` around it can recreate the rows.

## Load code at its existing boundary

Use `lazy` for the component code, and retain the route's existing component
loader. The loader still controls when import begins and when the router
considers the module ready:

```ts
// route.tsx: keep rendering and its runtime imports behind the route boundary.
component: async () => {
  const entry = await import("./cron-page-entry.tsx");
  await entry.CronPage.preload();
  return entry;
},
```

```tsx
// cron-page-entry.tsx: loaded only by the route's component loader.
export const CronPage = lazy(() => import("./cron-page.tsx"), { export: "CronPage" });
export const header = true;
export function renderSolid(props: SolidRouteProps) {
  return (
    <Loading>
      <CronPage routeSearch={typeof props.data === "string" ? props.data : ""} />
    </Loading>
  );
}
```

Do not invoke `preload()` at module scope or import the page implementation
from startup. Keep the loader's current retention/error behavior. JSX belongs
in `.tsx`; replace hand-written `createComponent` rather than keeping a second
render helper. Check startup bytes against the base on the same machine.

Check the emitted graph as well as the source import. The first use of an
action made Solid retain runtime initializers; the generated boot groups
initially put them beside Markdown code, which pulled that entire chunk into
startup even though cron stayed lazy. The chunking owner keeps these small
runtime modules together. Do not fix grouping by importing private package
internals. The one-time shared Solid action/optimistic runtime cost was explicitly
approved for W-SOLID2-RECIPES, with its offset tracked by HF-STARTUP-BUDGET;
that exception does not authorize later pages to increase startup budgets.

## Reveal sibling regions

Cron's scheduler status and jobs list come from separate owner reads. Put
their sibling readiness boundaries under one `Reveal`. Cron preserves natural
readiness: a held scheduler-status request must not hide a completed jobs list.

```tsx
<Errored fallback={readError}>
  <Reveal order="natural">
    <Loading>
      <SchedulerStatus status={statusRead()} />
    </Loading>
    <Loading fallback={<JobsLoading />}>
      <JobsTable jobs={jobsRead()} />
    </Loading>
  </Reveal>
</Errored>
```

`natural` reveals each ready sibling independently. Use `together` only when
the page's contract requires both; the default `sequential` reveals them in
registration order, and `collapsed` suppresses later sequential fallbacks.
Choose based on the existing page's behavior. Put `Errored` **outside** the
group: an intervening `Errored` or nested `Loading` breaks membership in the
outer `Reveal`. Do not coordinate unrelated slots merely to use the API.

Key the table consumer to its presentation scope with `Show keyed`. `Loading`
retains its children during revalidation; an existing `createProjection` over
a retired optimistic store must not survive a Gateway scope replacement.
The keyed boundary changes only for owner/connection identity, so ordinary
query refreshes retain the rows and their DOM identity.

Keep the table structure and its `aria-busy` in both pending and ready states;
the fallback must preserve that accessible shell. Narrow a shared
props dependency with `createMemo(() => props.reads.scope())` before using it
in `on={latest(scope)}`. `on` tracks dependency changes rather than comparing
the returned scope, so reading a changing aggregate props memo directly can
re-arm the fallback on every list refresh and discard retained rows.

## Proof when adopting a recipe

Prove delayed reads, a failed read with a real retry, replacement connection
or scope, and mutation settlement through the visible page boundary. A held
mutation should show the optimistic enabled value and saving affordance,
retain row identity, and reconcile both success and rejected writes to the
owner. Preserve save/delete confirmation, conflicts, and draft retention.
Use the campaign's narrow local proof budget and PR CI for broad coverage.
Report the refactor checklist counts, production LOC, lazy boundary/startup
comparison, and inspected synthetic before/after screenshots.
