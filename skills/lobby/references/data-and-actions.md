# Data, state, and effects

Choose the smallest existing contract that meets the request. Tool schemas and
the current capability result are authoritative; examples do not grant access.
The dashboard host runs inside the iOS Lobby, but an inline transcript widget or
native panel may expose different APIs. Do not infer host support from the platform
name. Use the documented initialization/lifecycle rather than assuming a bridge
is ready at script load.

| Need                             | Existing route                                                     | Boundary                                                                                |
| -------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Clock, game, filters, thresholds | Local JavaScript/DOM/SVG                                           | No agent turn per tick; loaded state need not survive relaunch                          |
| Ordinary static data             | Native `report` blocks                                             | No executable widget needed                                                             |
| Public API from the client       | `capabilities.netOrigins`, exact HTTPS origins, then browser fetch | Grant and CORS still apply; no secret or anonymous fallback for an authenticated source |
| Gateway/project data             | Advertised `openclaw.data.read(bindingId, params)`                 | Exact binding and grant; never arbitrary host file paths or RPC                         |
| Shared GitHub Actions data       | Approved named query, `openclaw.data.query(name)`                  | Query is declared completely; do not add runtime overrides or expose credentials        |
| User-requested agent follow-up   | `openclaw.prompt.send(text)` where available                       | A visible user action; not a background timer or privileged command                     |
| Session notice                   | `openclaw.state.emit(payload)`                                     | Emits a notice; it is not state save/load storage                                       |
| External operation               | Advertised plugin verb through an approved named action binding    | Fixed selected destination and operation; fresh interaction; no generic shell bridge    |
| Existing automation              | `openclaw.cron.trigger(jobId)` with exact approved capability      | Runs an existing job; not permission to create an automation                            |

For Gateway reads, declare exact binding IDs in `capabilities.tools`, for example
`{"tools":["sessions.list"]}`, then call `openclaw.data.read("sessions.list", params)`.
For usage, use `{"tools":["usage.status"]}` with that binding. `dataBindings` is
not a capability field. A valid JavaScript call cannot compensate for an invalid
or missing declaration; check both against the advertised schema.

Before implementing a Gateway adapter, call `dashboard` with `action: "capability_describe"` and the exact advertised `capabilityId`. This is metadata discovery, not a grant or a live read. Respect `resultCoverage`: `partial` describes only the listed fields, and `unavailable` means the complete contract has not been exposed. For inputs, `inputCoverage: "empty-request"` means use an empty parameter object; `inputCoverage: "unavailable"` requires discovering the maintained input contract before constructing a query. Do not treat a partial reading guide as a complete response validator. Never treat unknown/inactive capabilities as executable.

Resolve a source from its maintained contract or an authorized bounded observation before writing its adapter. Reuse the advertised owner for identity and scope: a display name, title, or free-text mention is not an ownership key. Request the smallest supported scope at the source rather than loading unrelated records and guessing membership afterward. If the contract cannot be discovered, state the missing support; do not recursively search arbitrary fields for plausible numbers or invent response aliases.

Keep absent, empty, partial, failed, and stale results distinct. Pagination and source coverage are part of the result, not optional presentation details. Missing activity is unknown, not idle; missing checks are unknown, not passed. Validate units and timestamps against their source. An invalid response must take the unavailable path, not become an empty successful list. A snapshot can support local interaction without claiming a live connection or offering a refresh that cannot obtain new data.

Keep authoring tools, component read bindings, and executor commands distinct.
An executor's prerequisites are not extra `capabilities.tools` entries. For
example, a pointer action can require `computer.act` and `screen.snapshot` at the
node while the component declares only its approved action binding.

For an external action, declare `capabilities.actionBindings` as entries with
`name`, advertised `actionId`, and `params` containing fixed scalar selectors.
Read the verb's `requiredActionBindingParams`; put every required selector in the
binding, not in runtime arguments. Call `openclaw.action.run(name, dynamicParams)`
from a real user interaction in this component. Never repeat or override fixed
keys in `dynamicParams`. Each named call consumes that interaction; a timer,
autoplay, or queued stream must not synthesize another. Changed bindings need a
new permission decision. An API response is not proof of the physical effect.

When the optional Device Controls plugin is actually advertised and its selected
node is connected and explicitly allowed, it provides these narrow contracts:

- `device-controls.audio`: fix `nodeId` and a unique `operationId` UUID; pass
  `notes: [{frequencyHz, durationMs}]` and optional `volume`. Use 1–32 notes,
  20–8000 Hz, 20–2000 ms each, at most ten seconds total, volume 0–0.25.
- `device-controls.audio-stop`: a separate binding with the same fixed node and
  operation UUID; no dynamic arguments. Share that UUID only between controls
  intentionally addressing the same playback. Stop also requires interaction.
- `device-controls.pointer`: fix `nodeId`, `operation` (`move` or `scroll`),
  `screenIndex`, `referenceWidth`, and `referenceHeight`. Both move and scroll
  require bounded `x`, `y`; scroll additionally requires direction and amount
  from its schema. The
  executor requires both `computer.act` and `screen.snapshot`; disclose that it
  observes the selected screen internally to map input. It owns the fresh frame
  inside one native execution, without exposing screenshot pixels to the component.
  Changed display geometry requires a refreshed binding and approval. No clicks, held
  buttons, keys, or continuous joystick stream are part of this contract.

Do not enable the plugin, allow a node command, install an executor, or grant OS
permissions as an ordinary authoring side effect. Discover actual availability
and the intended target first; no fallback to a different computer. Keep an
uncertain external result visible and do not automatically replay it. Distinguish
a confirmed successful acknowledgement from an error or indeterminate result:
a successful acknowledgement may permit the next fresh user action. It does not
prove independently observed physical behavior, but that distinction alone is
not a reason to permanently disable the controls.

Local media/Web Audio can require a user gesture. “Play on my computer” is a
remote effect with a selected target; do not silently play on the phone instead.
Mouse movement or a joystick stream needs a suitable advertised action contract;
a successful local animation is not proof that the computer was controlled.

If durable game/checklist state, inter-component events, or another capability
has no advertised owner, say so. Do not invent `openclaw.state.save/get`, use a
session notice as a database, or claim opaque-origin browser storage is durable.
A useful local-only version can be offered with its limitation explicit.

For refreshing data, keep the last successful value separately from error and
freshness. Example responses describe a schema; they are not a substitute for
calling the advertised source. Show not loaded until that read completes. Refresh
must perform another read, not just redraw examples or advance a timestamp. Label
source observation time separately from local retrieval time; update the latter
only after a successful read. Validate the actual timestamp format and units.
Use one bounded in-flight read and a timeout. Retry with a delay only when the
requested refresh policy permits it; honor manual-only refresh, rate limits,
and stop retrying after permission denial. Use visibility/lifecycle
signals actually available, and release timers, listeners, and requests on
teardown. Resume with a fresh snapshot when deltas may have been missed. Do not
claim uninterrupted iOS background execution or offline bootstrap.

Agent views must keep configured, connected, running, and completed states
separate. Derive each claim from an available observation; an agent listing alone
does not prove a run is active. A prepared handoff is a draft until an authorized
send succeeds; an acknowledgement does not prove delivery or an observed effect.

The component permission menu approves or rejects the complete declaration; it
does not provide individual capability toggles. Plugin configuration, node
connection, command policy, and OS permissions are separate prerequisites. Never
auto-enable those owners or treat component approval as replacing them.

Changing an origin, query, or action binding can require a new grant. `capabilityState: "pending"`
means the operator must review the permission card; `rejected` is not a reason to
widen scope or retry with another identity. Direct HTTPS grants constrain origins,
not all methods, paths, or data sent to that origin. A read-only requirement needs
a read-only binding/account or another real owner, not a promise in JavaScript.

External library code can read the component's content and use its capabilities.
Prefer self-contained content when it includes private data. Do not put private
values in CDN/asset URLs or load external code merely for decorative styling.
