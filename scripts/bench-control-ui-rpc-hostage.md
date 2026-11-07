# Per-method RPC hostage census

Serve a production Control UI bundle against the shared mock Gateway, discover
which methods each flow calls, and delay one wire method at a time. This command
never builds the host UI or connects to a live Gateway. Use the repository Node
runtime and `NODE_DISABLE_COMPILE_CACHE=1` on the SSD.

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-rpc-hostage.ts \
  --mode census --bundle-dir .artifacts/base-bundle --source-root . --flows all \
  --engines chromium --delays 3000,forever --output .artifacts/rpc-census

node --import ./scripts/tsx.mjs scripts/bench-control-ui-rpc-hostage.ts \
  --mode census --bundle-dir .artifacts/head-bundle --flows devices \
  --methods config.get,exec.approvals.get --delays 3000,forever \
  --screenshots --output .artifacts/rpc-devices
```

`--mode discover` only records ordinary requests. Discovery covers cold boot,
one warm reload in the same context, session switch, and every core route's
first visit. Each flow uses a fresh context. Route fixtures come from
`createEnginePageScenarios(0, "chat")` and `createScenarioFixture`, with the same
canonical synthetic session-list owner and request handlers as the engine
benchmark. These retain the large Chat boot transcript and provide the route's
realistic config, schema, inventory, backup, and other response shapes. Native
plugin assets use the existing mock installer. Workboard and plugin visits use
`createWorkboardResourceFixture` and boot at New conversation, matching their
engine fixture. They show the initial 100-card page of a 1,000-card inventory;
the census does not preload the remaining cards. `--source-root` must name the
Git checkout matching the bundle (default `.`). When either route is selected,
the existing native fixture owner validates its committed Workboard sources and
compiles one cached plugin generation. `results.json.builds[].workboardSource`
records the source revision, browser tree, catalog, asset sizes and hashes.

`results.json.flowCoverage` records the owning engine scenario, excluded or
unavailable routes and their reason, and observed redirect destinations. Engine
coverage exclusions remain exclusions here; the cold/warm/session-switch flows
cover Chat separately. A baseline page error or rendered lazy-panel failure is a setup gap and
prevents that flow's delayed-method sweep. `--methods` limits the census;
otherwise it exercises every discovered method. `--rpc-rtt-ms 100` adds mock
response delay to each known method, without HTTP bandwidth or asset latency.

A forever hold lasts for `--observe-ms` (default four seconds), then releases.
Recovery is observed for up to two seconds after navigating away and back.
Every sample records the requested route, path and query separately from the
baseline-resolved destination, including legitimate redirects. Recovery always
re-enters the requested destination and verifies the baseline destination;
the previous page cannot satisfy it. Devices and Systems additionally require
visible inventory before data recovery succeeds.
This is a bounded observation, not proof that a longer product timeout cannot
recover. Methods not reached remain absent. Use fresh output directories for
different bundles.

Readiness timestamps use the document clock sampled on animation frames, not
driver time or CPU. Results separate shell, route, roster, composer, transcript,
content, Devices/Systems inventory, policy and bindings. Generic content means visible
nonempty route text, not completion of every data source. Null means pending;
never substitute the timeout as a timing sample. Raw checkpoints preserve
skeletons, errors, visible rows, text and request counts. Native composer input
is attempted after 300 ms on composer flows; navigation is tested before held
responses are released. `navigationWorks` records the programmatic API result;
`nativeNavigationWorks` first restores and verifies the baseline-resolved
destination, then clicks the visible Settings “Back to app”
control when present, then the visible New conversation link, and checks the
committed destination. A target that cannot commit, or a missing or blocked control, records a false result and
`nativeNavigationError`. Both probes run outside readiness timing and before
forever-held responses are released. Screenshots contain synthetic fixtures only.

Use the established engine benchmark for rotated timing comparisons and A/A:

```sh
node --import ./scripts/tsx.mjs scripts/bench-control-ui-engines.ts \
  --bundle-dir .artifacts/base-bundle --compare-bundle-dir .artifacts/head-bundle \
  --control-bundle-dir .artifacts/base-bundle --engines chromium,webkit,firefox \
  --viewport desktop --steps page-devices-visit --page-origin chat --pairs 20 \
  --rpc-delay-method config.get --rpc-delay-ms 3000 --output .artifacts/rpc-timing
```

Repeat without method delay and with `--network-profiles rtt-100ms` for controls.
Use browser-local `evidence.visitReadyMs` for route readiness; `scenarioMs`
includes driver work. The default boot fixture has 1,000 sessions, 400 messages per active
session, 1,000 models and 500 jobs. Route-specific inventories come from the engine
scenario (Devices, for example, uses its 30-node inventory). A 45-second host
watchdog records renderer stalls separately from product readiness. Use
`OPENCLAW_CAPTURE_UI_PROOF=1 --diagnose` for a diagnostic run with the existing
stall collector; exclude diagnostic runs from timing comparisons.
