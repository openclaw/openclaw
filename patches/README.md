# Temporary dependency patches

Keep existing insertion anchors when extending these patches: pnpm 12 can apply a zero-context, zero-length insertion one line early. After regeneration and installation, verify installed files against the patch's target blob hashes before testing.

`@awesome.me/webawesome@3.14.0` retains its approved dropdown, submenu, select, tooltip, and animation lifecycle repairs. The dropdown initializes focus after its popup becomes usable, before joining animation cleanup or completion, and preserves a newer composed focus target during popup rendering. Freshly mounted open menus also join the popup's initial anchor resolution before focusing; already anchored menus retain their existing visibility and native occlusion across reopen. Initial-focus handlers can close or disconnect the menu; the existing transition owner fences those reentrant paths before starting an animation. Opening completion never resets a newer item, submenu, or outside focus. Both published distributions carry the same owner. The tooltip trigger handler uses upstream's `containsComposedNode` helper to retain the 3.13 fix for hover across Shadow DOM slots; the port also preserves upstream overflow-tag size and pill styling.

The published integrity is `sha512-m5rTGLK/iOvaVFOkYxRjiBOp8lwrBap5tv+zz1gsqLgAxlfwdvElB7BVGjs+Lf9gDps7bWRPTkG0FwZk40mk2A==`; the patch SHA-256 is `83b8b6c3daff77f34e0d6ed0802580b5336e3754fd2874dd3077cd20a4e6f117`.

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

`matrix-js-sdk@43.0.0` has an approved temporary patch for saved-sync verification replay. Classic sync propagates its existing cache provenance through ordinary client events, and the crypto listener ignores restored events. This preserves room history, sync cursors, ordinary event listeners, fresh verification events, and to-device processing while preventing cached verification requests from restarting after a clean client shutdown. Version 43.0.0 still routes restored events into crypto, so the patch remains necessary.

The published integrity is `sha512-d2w/VPJoMgE9g015sAsHFqODe+B7KJ8zdm077i8luKTwG4PQrchCd74r65IiPqR5t97ZYz/8FZyujvamgB/7qQ==`; the patch SHA-256 is `c3ad7f3afbd9ded4643fbfa31f5862d48d4e05d198cb438efbb4fcdaa845b0cc`.

Remove the Matrix patch, its registration, and its exact-version guard exception when an upstream release passes `node scripts/run-vitest.mjs extensions/matrix/src/matrix/client/file-sync-store.sdk.test.ts` and the full Matrix QA catalog, including the original DM SAS-to-QR sequence. The regression exercises the real SQLite sync store, SDK cache hydration, and crypto event wiring; it observes crypto input rather than substituting for native verification proof.

`vitest@5.0.3` has one approved exact-version pnpm patch. Vitest 5 bundles the
runner, and `@vitest/runner@5.0.0` is not published, so no standalone runner
dependency or patch remains. The published package integrity is
`sha512-xMw97S3rjdtj5dkVat7jCsqWBpvchs3RlpQctUqwJD0KkERk40vz2fJ77lDwW/Vzh/pk18eItYAzkodhSes3jQ==`.
The patch SHA-256 is
`b9cf06b8bd5da1ffe896837133366083382a1bbe0fb5b39274ebde46d060d53d`
and it changes exactly these eight published files:

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/chunks/cac.DfDGTQ9W.js` | `96e83ae033d86fe0880fe4be5653b2f951dc64da1a4949d57e9fe13f30193c2b` | `aca077f8504c553ba163890b3e1105f37a5e15bfc1f1ae35e6fd485005f4c340` |
| `dist/chunks/index.k8L_ZRzq.js` | `7439d9401700769f7c98b22f43013c48fdac7676aa4752112ddf214dc3bfdace` | `9d52a1982059dcd6a1fe4e8befc0cc01958276c3857b8529a796f13e40e504d3` |
| `dist/chunks/index.DpLw24bj.js` | `1530a89d189ebdc57a1577e7fbfcd34eac55a0165589265b8d776b33f83678bd` | `e54b450d9fad566fa4e1cb487019fa0555143fc290f37eccc79ad84cb5174661` |
| `dist/chunks/index.C4tKZ0yW.js` | `82c2b55e5dd5245c0c5e9eccd73fa6d7ade2694644175967e27a28b67932cb9d` | `127e5095648591a963931703918ab2393e161719f8ec2cb3449535b293646a5e` |
| `dist/chunks/init-forks.hzLs7kMZ.js` | `60d4cdf744079a261cf557a1dc47cb359428abc55c1259cbc0c26b9689e22a8d` | `1b45c7a12c0f2718d376fadf55eafc0b0e41029dd12e51098936d37242ad9755` |
| `dist/chunks/plugin.d.BsjqSb4-.d.ts` | `2f6c3ffdacc06be06f7eb0547e6816adac64c63f203c6df27f1aa5a9dd63db89` | `7fe05fb805eb6f389142288e28e2c3053262bec06b9879a99a2cf87ae89fa4f6` |
| `dist/chunks/run.BTlFXlnv.js` | `950469eb28cec3faa51f30c3203e1ab3099b54a52e3282b05f388930e7769717` | `e5ca2c49ef1c777dd8bbd960ab330568b15d35ce784270654a64b1f66c218220` |
| `dist/node.d.ts` | `b6d8f31914c6998f20574cf204323a5325d32f99a4e4d7b8eff7a343b8e47c04` | `3ef9736d58bed0960cef192502b41f239018469770d07859d8d57278005195ab` |

Vitest 5.0.3 writes replacement cache metadata upstream; the patch uses that
`writeMetadata` owner and retains the remaining generation and invalidation
repairs. The patch owns these temporary invariants and removal gates:

- **Mock resolution (`index.k8L_ZRzq.js`):** module fetches join the mocker's
  serialized resolution before reading its registry, even after the pending-id
  queue is emptied by an in-flight pass. Resolution drains ids queued during a
  pass; failed callers retain their errors without poisoning later callers.
  Shared-worker cleanup joins the native completion tail. Remove this hunk when
  stock Vitest passes `test/scripts/vitest-mock-resolution.test.ts` and the
  original cold Gateway CI group containing
  `authenticated-request-dispatch.lifetime.test.ts`.
- **CLI validation (`cac.DfDGTQ9W.js`):** public `parseCLI` validates unknown
  options, required values, and required arguments without executing a command.
  Help/version and `allowUnknownOptions` retain native semantics. Remove this
  hunk when stock Vitest passes the native validation cases in
  `test/scripts/run-vitest-profile.test.ts` and
  `test/scripts/vitest-report-owner.test.ts`.
- **Filesystem cache generations (`index.DpLw24bj.js`):** persistence remains
  disabled until lockfile integrity completes; generation participates in cache
  keys; lock transitions rewrite metadata and reset retained roots, keys, and
  transform temporary markers; invalidation covers the root and selected
  projects. Remove these hunks when stock Vitest passes the four cache-generation
  and invalidation regressions in `test/vitest-performance-config.test.ts`.
- **Graceful fork shutdown (`index.DpLw24bj.js`,
  `init-forks.hzLs7kMZ.js`, `plugin.d.BsjqSb4-.d.ts`, `dist/node.d.ts`):**
  built-in fork workers flush a `willExit` response, exit explicitly, and are
  joined before run completion. Deadline and abnormal-exit paths still fail and
  terminate the worker; custom transports remain parent-owned unless they opt
  into the contract. Remove these hunks when stock Vitest passes
  `test/scripts/vitest-fork-shutdown.test.ts`,
  `test/scripts/run-vitest-state-cleanup.test.ts`, and
  `test/scripts/run-vitest-profile.test.ts`.
- **File-backed report projects (`index.DpLw24bj.js`,
  `plugin.d.BsjqSb4-.d.ts`):** a Vitest-owned
  `{ config, root?, namePrefix? }` descriptor loads its config exactly once,
  keeps the file-owned root when omitted, preserves the explicit root when
  supplied, and derives its final name after Vite hooks. A replayed prefix
  retains the container-owned identity and marks the executed config as a
  standalone project so its children are not rediscovered. Remove these hunks
  when stock Vitest passes
  `test/scripts/vitest-report-owner.test.ts` without pre-resolving configs or
  injecting captured names and `test/vitest-ui-package-config.test.ts` without
  losing omitted or explicit project roots.
- **Trailing task updates (`run.BTlFXlnv.js`):** the bundled runner accepts the
  exact batching deadline and clears a consumed timer before re-entering the
  throttle, so an early callback can rearm without losing the trailing update.
  Remove this hunk when stock Vitest passes
  `test/scripts/vitest-runner-task-updates.test.ts`.
- **Fake timer heap order (`index.C4tKZ0yW.js`):** refresh removes a timer from
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
