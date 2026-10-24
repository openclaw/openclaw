# Temporary dependency patches

Keep existing insertion anchors when extending these patches: pnpm 12 can apply a zero-context, zero-length insertion one line early. After regeneration and installation, verify installed files against the patch's target blob hashes before testing.

`@solidjs/web@2.0.0-rc.18` has an approved retention patch in its production,
development, and observe browser builds. The lazy select-insertion callback is
declared at module scope so it cannot retain the first value-bound select through
V8's shared closure context. Selection, option insertion, change listeners, and
the same-turn microtask retry are unchanged. Upstream is `solidjs/solid`, branch
`next`, package `packages/web`; this release was published from
`225014bf8757421a2ea0a9c6ddc148b965eed000`.

Remove this patch and its exact-version guard entry when a published upstream
version passes `scripts/control-ui-retention/dependency-retention.test.ts` without
the patch. That probe uses a fresh browser document per runtime build and checks
that the first select and its enclosing form are collectible after disposal.

`@solidjs/signals@2.0.0-rc.18`, from the same upstream revision, has an approved
idle-disposal patch in production, development, and observe builds. Disposing a
computation schedules the existing pending-queue drain when the queue has
entries, including readers queued by an idle rejection without a staged flag.
Already-drained nodes do not schedule empty flushes. This preserves the existing
transaction and stale-reader scheduling conditions without a synchronous flush
or queue scan during disposal.

Remove this patch and its exact-version guard entry when the dependency probe
passes with an upstream release. The idle case requires collection without
subsequent reactive work. An explicit `flush()` is a no-op when no work is scheduled.

`chrome-devtools-mcp@1.11.0` has an approved exact-version snapshot-identity patch, backported from [ChromeDevTools/chrome-devtools-mcp#2788](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/2788) at `06c8d4bc44f68bde8bd3fcd97dcc47375df81fe9` and forward-ported onto tag commit `a878bcad39584337e055778353246820deafa7c0`. Stable IDs include the frame's captured CDP session and document generation; ambiguous IDs stay capture-local, and stale lazy handles cannot resolve into a replacement renderer. Frame-local lookup and retained extra handles preserve actions and labeled screenshots. The 1.11.0 CSS-style lookup resolves the same guarded handle and stays within its captured renderer, failing closed when the embedded DevTools target cannot represent a cross-renderer frame. Version 1.11.0 already exports its bundled `CdpFrame`, so the patch changes only the snapshot owner and its DOM-result caller. Original license notices remain intact, with modifications recorded in `build/src/OPENCLAW_PATCH_NOTICE.md`.

The published integrity is `sha512-CytJ/5tnzrS+J/74be2P5aCOsS/mmGRHys/Si+IYC4ucrbnWAmES/dYdxGJjeUCECRcoFUilZAysdjlwqUjXIA==`; the patch SHA-256 is `c2e391b196607620c519f04eb1563dc4a8f01aebed3b70bd77e6635ae03a5c9a`.

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `build/src/McpPage.js` | `ad350b4b067b7c8e34706488d543869e71a7bcba73f2df45e35f7d518469f358` | `4044a30df6292a5d4517f718c32818e9c85f8051c318ec88bef7aa127d883a36` |
| `build/src/OPENCLAW_PATCH_NOTICE.md` | Added | `41aada055258ec8754581f6cee1e3ed505499be8373969e6267031ebabc00594` |
| `build/src/TextSnapshot.js` | `c81a4b9d989524256d365e252c2610ec1e8d8883f976da18e4d6b115e274b83d` | `5c647c3d0b416bdfc1bcaf1b1136f6a7682db05cf59982e3ab6f17d00d2d17ac` |
| `build/src/third_party/index.js` | `b047499006b0027bd37165fa8197fa6fa5caa9b8c07d938992857659270ec493` | Unchanged |

The root package bundles this patched dependency so npm installations preserve the same bytes as pnpm source installs. Browser launches the packaged CLI directly with the runtime running OpenClaw, Node or Bun. Remove this patch, its registration, and the patch-specific package checks when a published upstream version passes `pnpm test:e2e:browser-mcp` and the installed-package stdio proof, including renderer replacement, cross-origin frames, cancellation, and snapshot → wait → action.

`@novnc/novnc@1.7.0` has an approved temporary patch for ignored extended-clipboard payloads. The RFB owner consumes the remaining compressed bytes before returning for view-only clients or unsupported clipboard formats. It does not inflate or publish ignored clipboard data, and controlling text clipboard handling stays unchanged. This keeps clipboard bytes from becoming the next RFB message and disconnecting WebVNC.

Remove the noVNC patch, its registration, and its exact-version guard exception when an upstream version passes the Desktop panel and document browser suites (`test/vitest/vitest.ui-e2e.config.ts`) and the live view-only selection/type stress check. The regression uses the real noVNC parser, covers coalesced and fragmented payload delivery, and requires the next framebuffer update without a reconnect.

`matrix-js-sdk@43.0.0` has an approved temporary patch for saved-sync verification replay. Classic sync propagates its existing cache provenance through ordinary client events, and the crypto listener ignores restored events. This preserves room history, sync cursors, ordinary event listeners, fresh verification events, and to-device processing while preventing cached verification requests from restarting after a clean client shutdown. Version 43.0.0 still routes restored events into crypto, so the patch remains necessary.

The published integrity is `sha512-d2w/VPJoMgE9g015sAsHFqODe+B7KJ8zdm077i8luKTwG4PQrchCd74r65IiPqR5t97ZYz/8FZyujvamgB/7qQ==`; the patch SHA-256 is `c3ad7f3afbd9ded4643fbfa31f5862d48d4e05d198cb438efbb4fcdaa845b0cc`.

Remove the Matrix patch, its registration, and its exact-version guard exception when an upstream release passes `node scripts/run-vitest.mjs extensions/matrix/src/matrix/client/file-sync-store.sdk.test.ts` and the full Matrix QA catalog, including the original DM SAS-to-QR sequence. The regression exercises the real SQLite sync store, SDK cache hydration, and crypto event wiring; it observes crypto input rather than substituting for native verification proof.

`vitest@5.0.5` has one approved exact-version pnpm patch. Vitest 5 bundles the
runner, and `@vitest/runner@5.0.0` is not published, so no standalone runner
dependency or patch remains. The published package integrity is
`sha512-cPODOMF8YnkiiYtDdHo6n4wWmBrOBBbOIYH2d33M4l3CdNn72h+qMmO6uXffUN6A5AZFXNND/d+krS9mgkXRfg==`.
The patch SHA-256 is
`abb35069c56858589f463527013088f26c8da59c6cccfd5c48b35c472caac355`
and it changes exactly these nine published files:

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/chunks/cac.CLrZKo1g.js` | `cbe6e023d5b1e5c8de648da0d43242e660d88676b172a022d2b95f22a88b78c0` | `5c429f733a64ee9a0de35db6fe15f5ee10d03ae784f664faf0afe940896ad7fb` |
| `dist/chunks/cli-api.De07GUeT.js` | `8b75d08fd468ac1428ef5562e43883e2cf1953c8953a7eab95da17b30ed97945` | `39173bec8f75564cd8db538593973cdf101a8321fd2a9c26d9d5edfa6ac3af53` |
| `dist/chunks/index.1TqnEahn.js` | `4e311af8b4db378a5c3d4e768b5210b0779d2ae0d0ec05f81a72378dbaf25412` | `17c97be7f0b926e164c7d36273677964379959884024a74e72c0b2fed07d3baa` |
| `dist/chunks/index.CK-t0WMg.js` | `4712d1e9acaefca5d215c21f53007eeae30904768d45a10cd1fd09c01c6fd46e` | `605c675633a59166e5ca9b04108f4b34ca9f3cf2e3cc41a292f8277ec64aaa99` |
| `dist/chunks/index.aTZaPVhf.js` | `381472b0170386acbc3f7d05b68ef05b3da53dcaa1058d2750d138648cd2933a` | `9fed49edda9cac115628ff4203ca307200ff721786925654044fbe4076be5ad9` |
| `dist/chunks/init-forks.CRxIPOJR.js` | `ef3f4026f3bc661f0542e379186637000cd2e6721e78733a4d5b5e9d3de46a64` | `03632dcb32e05236d984c58f2c8aed1a3eac7cb945594e9e0bd8bb32b2a18316` |
| `dist/chunks/plugin.d.C8mmycim.d.ts` | `e1eae7448953ae3951958097b083af35b50f3adc39f0a922baa14de48324ac2f` | `59aed92bfefac4243398514cd6b274dab1ddc8841ed834d63eef6ff29d625bb7` |
| `dist/chunks/run.BPv-BBRv.js` | `6353810fdd2b6370386dfb80ec4d1415b2a12d83e00f3ebee83cc0304d6e4c6b` | `0d1eb0c41c32a0e3040d108efc634fc405b1a2c437ca3414a284d84929c59199` |
| `dist/node.d.ts` | `3cbd85d6dc3f7c97d2ced382172f12a115d46352af8d2a71fec05f9b185baf90` | `0b5cd4c6333b41b11f948f96c1b56809beb07d256ac1b24eab644a197dd033ec` |

Vitest 5.0.5 writes replacement cache metadata upstream; the patch uses that
`writeMetadata` owner and retains the remaining generation and invalidation
repairs. The split runtime keeps cache integrity initialization with upstream
`VitestCache._load()`, moved before reporter imports so persisted reporter transforms
share the checked generation. The patch does not reintroduce the retired `_fsCache` owner.
The patch owns these temporary invariants and removal gates:

- **Mock resolution (`index.CK-t0WMg.js`):** module fetches join the mocker's
  serialized resolution before reading its registry, even after the pending-id
  queue is emptied by an in-flight pass. Resolution drains ids queued during a
  pass; failed callers retain their errors without poisoning later callers.
  Shared-worker cleanup joins the native completion tail. Remove this hunk when
  stock Vitest passes `test/scripts/vitest-mock-resolution.test.ts` and the
  original cold Gateway CI group containing
  `authenticated-request-dispatch.lifetime.test.ts`.
- **CLI validation (`cac.CLrZKo1g.js`):** public `parseCLI` validates unknown
  options, required values, and required arguments without executing a command.
  Help/version and `allowUnknownOptions` retain native semantics. Remove this
  hunk when stock Vitest passes the native validation cases in
  `test/scripts/run-vitest-profile.test.ts` and
  `test/scripts/vitest-report-owner.test.ts`.
- **Filesystem cache generations (`cli-api.De07GUeT.js`, `index.1TqnEahn.js`):** persistence remains
  disabled until lockfile integrity completes; generation participates in cache
  keys; lock transitions rewrite metadata and reset retained roots, keys, and
  transform temporary markers; invalidation covers the root and selected
  projects. Remove these hunks when stock Vitest passes the five cache-generation
  and invalidation regressions in `test/vitest-performance-config.test.ts`.
- **Graceful fork shutdown (`index.1TqnEahn.js`,
  `init-forks.CRxIPOJR.js`, `plugin.d.C8mmycim.d.ts`, `dist/node.d.ts`):**
  built-in fork workers flush a `willExit` response, exit explicitly, and are
  joined before run completion. Deadline and abnormal-exit paths still fail and
  terminate the worker; custom transports remain parent-owned unless they opt
  into the contract. Remove these hunks when stock Vitest passes
  `test/scripts/vitest-fork-shutdown.test.ts`,
  `test/scripts/run-vitest-state-cleanup.test.ts`, and
  `test/scripts/run-vitest-profile.test.ts`.
- **File-backed report projects (`index.1TqnEahn.js`,
  `plugin.d.C8mmycim.d.ts`):** a Vitest-owned
  `{ config, root?, namePrefix? }` descriptor loads its config exactly once,
  keeps the file-owned root when omitted, preserves the explicit root when
  supplied, and derives its final name after Vite hooks. A replayed prefix
  retains the container-owned identity and marks the executed config as a
  standalone project so its children are not rediscovered. Remove these hunks
  when stock Vitest passes
  `test/scripts/vitest-report-owner.test.ts` without pre-resolving configs or
  injecting captured names and `test/vitest-ui-package-config.test.ts` without
  losing omitted or explicit project roots.
- **Trailing task updates (`run.BPv-BBRv.js`):** the bundled runner accepts the
  exact batching deadline and clears a consumed timer before re-entering the
  throttle, so an early callback can rearm without losing the trailing update.
  Remove this hunk when stock Vitest passes
  `test/scripts/vitest-runner-task-updates.test.ts`.
- **Fake timer heap order (`index.aTZaPVhf.js`):** refresh removes a timer from
  the heap before mutating its ordering key, then reinserts it. Remove this hunk
  when stock Vitest passes `test/scripts/vitest-fake-timers.test.ts` and
  `extensions/telegram/src/probe.response-body-timeout.test.ts`.

Generate and register dependency patches through pnpm; never edit installed
dependency files manually. A clean `pnpm install --frozen-lockfile` must apply
the recorded patch hash to the published integrity and reproduce every patched
target hash above.

`baileys@7.0.0-rc14` needs a two-line adapter for `audio-decode@3.12.0`:
read the first decoded channel from `channelData[0]` and require the matching
3.x peer. Version 3 returns raw channel arrays instead of an AudioBuffer;
Baileys otherwise catches the missing `getChannelData()` method and silently
omits voice-note waveforms. The existing Baileys owner retains waveform
normalization, media preparation, and best-effort decoding errors.

The patch SHA-256 is
`03ae85550381d1bda7d014c9aa9f544ad421d35d745d1167fd5d33f7f715dafb`.
The regression in `extensions/whatsapp/src/baileys-audio.test.ts` prepares a
real Baileys voice-note payload from deterministic PCM and checks its complete
64-byte waveform. Isolated dependency proof also covered Buffer, file, and
stream decoding, WAV and Ogg Opus voice payloads, and malformed-audio handling.
The plugin package owner bundles patched runtime dependencies so installed
WhatsApp plugins retain the adapter. Remove this patch and its registration
when an upstream Baileys version accepts the current decoder and passes the
same voice-note regression.

`playwright-core@1.64.1` has an approved syntax-only normalizer patch. Acorn
parses serialized callbacks in the same function-body grammar instead of
constructing a host Function. Execution remains in the target browser; ordinary
functions, method shorthand, and async methods retain Playwright's normalization.
The package extension supplies Acorn, and the root and browser plugin packages
bundle the patched runtime for npm installs. Remove the patch, extension, and
exact-version guard when upstream passes the browser serialization regression
with host string compilation disabled.
