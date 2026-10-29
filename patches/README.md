# Temporary dependency patches

Keep existing insertion anchors when extending these patches: pnpm 12 can apply a zero-context, zero-length insertion one line early. After regeneration and installation, verify installed files against the patch's target blob hashes before testing.

`@awesome.me/webawesome@3.13.0` retains its approved dropdown, submenu, select, tooltip, and animation lifecycle repairs. The dropdown initializes focus after its popup becomes usable, before joining animation cleanup or completion, and preserves a newer composed focus target during popup rendering. Freshly mounted open menus also join the popup's initial anchor resolution before focusing; already anchored menus retain their existing visibility and native occlusion across reopen. Initial-focus handlers can close or disconnect the menu; the existing transition owner fences those reentrant paths before starting an animation. Opening completion never resets a newer item, submenu, or outside focus. Both published distributions carry the same owner. The tooltip trigger handler uses upstream's `containsComposedNode` helper to retain the 3.13 fix for hover across Shadow DOM slots; the port also preserves upstream overflow-tag size and pill styling.

Remove the dropdown focus hunk when an upstream release passes `ui/src/e2e/chat-attachment-focus.e2e.test.ts`, the unchanged platform attachment menu suite, and both `web-awesome-dropdown*.browser.test.ts` lifecycle suites without a consumer animation wait. These tests use real CSS animation boundaries, native keyboard input, and the actual browser filechooser; mobile identities are emulated, not native OS-picker certification. Retain the other patch owners until their respective regressions pass upstream.

The popup disposes its previous Floating UI subscription before starting another and releases the new subscription if a synchronous reposition listener disconnects or deactivates it. Remove both popup hunks when an upstream release passes the public resize/disconnect lifecycle cases in `ui/src/components/web-awesome.test.ts` without retaining resize work after removal.

`chrome-devtools-mcp@1.10.1` has an approved exact-version snapshot-identity patch, backported from [ChromeDevTools/chrome-devtools-mcp#2788](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/2788) at `06c8d4bc44f68bde8bd3fcd97dcc47375df81fe9` and forward-ported onto tag commit `e52c6b59b476c5e04d8dd9fd4bd017ba3b3d65df`. Stable IDs include the frame's captured CDP session and document generation; ambiguous IDs stay capture-local, and stale lazy handles cannot resolve into a replacement renderer. Frame-local lookup and retained extra handles preserve actions and labeled screenshots. The 1.10.1 CSS-style lookup resolves the same guarded handle and stays within its captured renderer, failing closed when the embedded DevTools target cannot represent a cross-renderer frame. Version 1.10.1 already exports its bundled `CdpFrame`, so the patch changes only the snapshot owner and its DOM-result caller. Original license notices remain intact, with modifications recorded in `build/src/OPENCLAW_PATCH_NOTICE.md`.

The published integrity is `sha512-Klw6HWDqHC/XS1JwZldd2r49aUhbUJN9m9Mvcx4SEueIPXtzuQX+QelxAViobv8YUkDZ7HWDrmViR6LeYK0wAw==`; the patch SHA-256 is `d31d6e7e187ea9fd4dad87ed3ad08073c77ffcfddd52bc4761b39a2dfce0ac1e`.

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `build/src/TextSnapshot.js` | `f3496989b93d174723fcf394628fabc36936b37e6a815fd85cbe20fba46d5ea0` | `299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b` |
| `build/src/McpPage.js` | `d49b2666cb9c6c5b4d7b9130235c476cb8a3af580363ff224796d9dbde99538d` | `47aa13c6b28cc11e1b0883532edea97cfde7563d78d143035850852d09809975` |
| `build/src/third_party/index.js` | `c988e0684584b75e87ae04b768c4f8ae7064401afe5187ec0d4878b2c6833f12` | Unchanged |
| `build/src/OPENCLAW_PATCH_NOTICE.md` | Added | `4bf44b52a80b5860b2160bc83407a5f0dd09f1801c85d0a2b6e4fec26bd7045d` |

The root package bundles this patched dependency so npm installations preserve the same bytes as pnpm source installs. Browser launches the packaged CLI directly with the runtime running OpenClaw, Node or Bun. Remove this patch, its registration, and the patch-specific package checks when a published upstream version passes `pnpm test:e2e:browser-mcp` and the installed-package stdio proof, including renderer replacement, cross-origin frames, cancellation, and snapshot → wait → action.

`@novnc/novnc@1.7.0` has an approved temporary patch for ignored extended-clipboard payloads. The RFB owner consumes the remaining compressed bytes before returning for view-only clients or unsupported clipboard formats. It does not inflate or publish ignored clipboard data, and controlling text clipboard handling stays unchanged. This keeps clipboard bytes from becoming the next RFB message and disconnecting WebVNC.

Remove the noVNC patch, its registration, and its exact-version guard exception when an upstream version passes the Desktop panel and document browser suites (`test/vitest/vitest.ui-e2e.config.ts`) and the live view-only selection/type stress check. The regression uses the real noVNC parser, covers coalesced and fragmented payload delivery, and requires the next framebuffer update without a reconnect.

`matrix-js-sdk@42.4.0` has an approved temporary patch for saved-sync verification replay. Classic sync propagates its existing cache provenance through ordinary client events, and the crypto listener ignores restored events. This preserves room history, sync cursors, ordinary event listeners, fresh verification events, and to-device processing while preventing cached verification requests from restarting after a clean client shutdown. Version 42.4.0 still routes restored events into crypto, so the patch remains necessary.

Remove the Matrix patch, its registration, and its exact-version guard exception when an upstream release passes `node scripts/run-vitest.mjs extensions/matrix/src/matrix/client/file-sync-store.sdk.test.ts` and the full Matrix QA catalog, including the original DM SAS-to-QR sequence. The regression exercises the real SQLite sync store, SDK cache hydration, and crypto event wiring; it observes crypto input rather than substituting for native verification proof.

`vitest@5.0.1` has one approved exact-version pnpm patch. Vitest 5 bundles the
runner, and `@vitest/runner@5.0.0` is not published, so no standalone runner
dependency or patch remains. The published package integrity is
`sha512-iA95lQbKEkvrtTkdAgnWbXfbipWiiWe/hDl2P5tMi6WFwD76G0NxXAGp/M9EOcYupeGJRr6wppMc7CoA41TQjg==`.
The patch SHA-256 is
`90ba2969491e095cc2e92a4d38256dfcf64f85078ec29e1762b9429a00b35901`
and it changes exactly these eight published files:

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/chunks/cac.fSuRXrAx.js` | `0290aaa6677cb20fb472b7d101e66b879e982d3799e9eb69ae84652cb8ecacd4` | `36e72e47372bc2c77fdaa9725675644db84ce6f34f86ceb8422b2ac7f9c7ec39` |
| `dist/chunks/index.D4dXTzh9.js` | `70e7ab020f7f03ae96797ad10b46549cd2edb61e4a4d975ba08d10fe41a0bb9e` | `e45d5d5babb300e099fb955b2af65aea5604db6019d9f0bc1b397a323466b063` |
| `dist/chunks/index.DzobfTyw.js` | `26c9c3d31efea8bb6e5f6f495db89968ba820a26c0676341f3682ec5377d584d` | `a41a0c84d88ab4aaddf92eb7b11234fc4c72bae7386b63c91898e692e1a81a95` |
| `dist/chunks/index.m3L2HgmY.js` | `f56631635acaf90deb3b99e037afd8a2431ef685781ae3aa1109bb33d1d02702` | `5c0b1653ddd88eff204dccc35289f66eca06ec43878a6ec73bfc601c3e66be71` |
| `dist/chunks/init-forks.DgHqDQHC.js` | `7e424d9f059e2343698c78c082469198e05cc8b189484dbdd6b5236b21f9b443` | `2f0f61b0e41cbb3d44bfaff0ddb903c047b175c1e0494bd08f95cfd7b9b2848f` |
| `dist/chunks/plugin.d.CN87HSxv.d.ts` | `a93d72194894d0eb54e7c43bd41167195dcf6a17800ce18fcee1716e1905dda5` | `2491673a5b9de8255f53dd7e573763d35776e1ff42e0096f98ba31b431fd55e8` |
| `dist/chunks/run.C5UmxDPh.js` | `890fef0254ad442f55902adc9a7d0e639bb9ba5a78ef4fc53a30f10f1aa9f77c` | `6412031b0068dbe300b7af1ba27056be77c914d067cee69b3dc396b7da8df8cd` |
| `dist/node.d.ts` | `09b5ab06e7b242132974144474b24a0fddde568e0fb20d69215d156d78ac0d7f` | `7ffe96f8dd9ffcdf5f3d67e56c02f509a516072cd523c9dcef596ada77afd06f` |

Vitest 5.0.1 writes replacement cache metadata upstream; the patch uses that
`writeMetadata` owner and retains the remaining generation and invalidation
repairs. The patch owns these temporary invariants and removal gates:

- **Mock resolution (`index.D4dXTzh9.js`):** module fetches join the mocker's
  serialized resolution before reading its registry, even after the pending-id
  queue is emptied by an in-flight pass. Resolution drains ids queued during a
  pass; failed callers retain their errors without poisoning later callers.
  Shared-worker cleanup joins the native completion tail. Remove this hunk when
  stock Vitest passes `test/scripts/vitest-mock-resolution.test.ts` and the
  original cold Gateway CI group containing
  `authenticated-request-dispatch.lifetime.test.ts`.
- **CLI validation (`cac.fSuRXrAx.js`):** public `parseCLI` validates unknown
  options, required values, and required arguments without executing a command.
  Help/version and `allowUnknownOptions` retain native semantics. Remove this
  hunk when stock Vitest passes the native validation cases in
  `test/scripts/run-vitest-profile.test.ts` and
  `test/scripts/vitest-report-owner.test.ts`.
- **Filesystem cache generations (`index.DzobfTyw.js`):** persistence remains
  disabled until lockfile integrity completes; generation participates in cache
  keys; lock transitions rewrite metadata and reset retained roots, keys, and
  transform temporary markers; invalidation covers the root and selected
  projects. Remove these hunks when stock Vitest passes the four cache-generation
  and invalidation regressions in `test/vitest-performance-config.test.ts`.
- **Graceful fork shutdown (`index.DzobfTyw.js`,
  `init-forks.DgHqDQHC.js`, `plugin.d.CN87HSxv.d.ts`, `dist/node.d.ts`):**
  built-in fork workers flush a `willExit` response, exit explicitly, and are
  joined before run completion. Deadline and abnormal-exit paths still fail and
  terminate the worker; custom transports remain parent-owned unless they opt
  into the contract. Remove these hunks when stock Vitest passes
  `test/scripts/vitest-fork-shutdown.test.ts`,
  `test/scripts/run-vitest-state-cleanup.test.ts`, and
  `test/scripts/run-vitest-profile.test.ts`.
- **File-backed report projects (`index.DzobfTyw.js`,
  `plugin.d.CN87HSxv.d.ts`):** a Vitest-owned
  `{ config, root?, namePrefix? }` descriptor loads its config exactly once,
  keeps the file-owned root when omitted, preserves the explicit root when
  supplied, and derives its final name after Vite hooks. A replayed prefix
  retains the container-owned identity and marks the executed config as a
  standalone project so its children are not rediscovered. Remove these hunks
  when stock Vitest passes
  `test/scripts/vitest-report-owner.test.ts` without pre-resolving configs or
  injecting captured names and `test/vitest-ui-package-config.test.ts` without
  losing omitted or explicit project roots.
- **Trailing task updates (`run.C5UmxDPh.js`):** the bundled runner accepts the
  exact batching deadline and clears a consumed timer before re-entering the
  throttle, so an early callback can rearm without losing the trailing update.
  Remove this hunk when stock Vitest passes
  `test/scripts/vitest-runner-task-updates.test.ts`.
- **Fake timer heap order (`index.m3L2HgmY.js`):** refresh removes a timer from
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

## Zod 3.25.76 early collection bounds

zod@3.25.76.patch is a local Zod-3 adaptation of the early upper-size rejection
behavior in Colin McDonnell's upstream Zod commit
a0ebf970f2d752e5f58527cd2942ff48be4f46bd (colinhacks/zod#6652).
It is not an upstream Zod-3 release, a cherry-pick, or an A2UI/Zod-4 migration.
The implementation changes three branches in each of src/v3/types.ts,
v3/types.js, and v3/types.cjs: oversized array max/exact length and set max
return the existing aborted result before visiting elements. Set exact size
already delegates to max/min. No declaration, export, A2UI source, license or
Zod-4 implementation is replaced.

This mitigates collection traversal only where an upper bound is declared.
A2UI 0.12's catalog JSON-schema loader translates maxItems into such a bound;
0.11's loader does not, so its integration regression instead exercises a
custom bounded function schema through the public Catalog invoker. This does
not add protocol-wide message limits or protect unbounded arrays.

An oversized collection now aborts instead of returning dirty: element and
outer refinements do not run, and a failing union may report invalid_union
instead of the dirty branch's too_big. Valid transforms, preprocessing,
lower-bound failures and wrong-type rejection are covered by regressions.
The exact-version patch also affects other consumers resolving Zod 3.25.76,
including zod-to-json-schema; the separate parser embedded in Discord's SDK
and the package's v4 subpath are not changed. No global advisory clearance is
claimed. Keep source attribution and original copyright notices intact.

Run node --test test/scripts/a2ui-zod-bounds.regression.mjs and the native
node scripts/run-vitest.mjs run test/scripts/a2ui-zod-bounds.test.ts.

The package-patch guard registers only zod@3.25.76 at
patches/zod@3.25.76.patch. Other versions, paths and package-local patch
registrations remain rejected; no guard or blanket exception is disabled.
Remove this registration and patch when a maintained upstream release retains
Zod 3 public contracts and passes the same baseline/fixed Catalog regressions,
public declaration checks and Canvas bundle checks. Independent full-context
review and required hosted checks still gate readiness.

Patch SHA-256: 2f14d2000a3645bf519c1a1cc4848a71d55185327a9a976a4f033e7d507b727d

`@discord/embedded-app-sdk@2.5.0` vendors Zod 3 in both `output/lib/zod/lib/index.mjs`
and `index.cjs`; changing the separately installed Zod package does not repair
the browser SDK. This patch is a local Zod-3 adaptation of the early upper-size
guard in Colin McDonnell's upstream Zod commit
`a0ebf970f2d752e5f58527cd2942ff48be4f46bd`
([colinhacks/zod#6652](https://github.com/colinhacks/zod/pull/6652)), referenced by
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
It is not a cherry-pick, a Zod version upgrade, or a claim that all installed
Zod copies are fixed. Only the bundled array `.max()` / oversized `.length()`
and set `.max()` / oversized `.size()` branches change: return the existing
invalid result before iterating elements or invoking outer refinements.
The bundled Zod-3 map API has no upper-size constraint. Valid values, lower
limits, individual bound messages, enum fallback handling, declarations, and
exports stay on the existing API. Early rejection intentionally omits element
and refinement issues; unions may report an `invalid_union` wrapper rather than
the previous direct bound issue.

As checked on 2026-10-29, the maintained SDK stable release is still 2.5.0 and
3.0.0-beta.3 still depends on Zod 3. Upstream's Zod-4 migration
([discord/embedded-app-sdk#318](https://github.com/discord/embedded-app-sdk/pull/318),
authored by `renovate-bot`, head `81e49dfa871e935641d9b9591ed789e837dc89e1`)
is open, not an available compatible stable fix. This six-branch adapter avoids
replacing the entire embedded parser and changing the public schema major.
Remove the patch and its exact-version registration when a published SDK
passes `test/scripts/discord-sdk-zod.test.ts` without it, including the
production browser build. Keep the root dependency-advisory disposition
separate; this patch deliberately does not suppress audit findings.

The patch SHA-256 is
`016b529034315344702f9c7ac79ce5538b0934cf55381229946597b54343fdfd`.

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `output/lib/zod/lib/index.mjs` | `3030e5b032805870bb4a8674e36fd916885552832e52c6a0f2465a929ecec231` | `c520fe1f39ce21e24425fdfc49ab7905e23a2be049450eb549649ef87faabe75` |
| `output/lib/zod/lib/index.cjs` | `feb2389d716ac303c1e7df76df1d7c4c4d7fb35d5aef3456d43718b68cf46aa1` | `a7ad12c2c2f0cf5b5435d7b4232f4c78adc19812ec9c4ddada333518e06cd92a` |
