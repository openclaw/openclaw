# Temporary dependency patches

Keep existing insertion anchors when extending these patches: pnpm 12 can apply a zero-context, zero-length insertion one line early. After regeneration and installation, verify installed files against the patch's target blob hashes before testing.

`@awesome.me/webawesome@3.12.0` retains its approved dropdown, submenu, select, tooltip, and animation lifecycle repairs. The dropdown initializes focus after its popup becomes usable, before joining animation cleanup or completion, and preserves a newer composed focus target during popup rendering. Freshly mounted open menus also join the popup's initial anchor resolution before focusing; already anchored menus retain their existing visibility and native occlusion across reopen. Initial-focus handlers can close or disconnect the menu; the existing transition owner fences those reentrant paths before starting an animation. Opening completion never resets a newer item, submenu, or outside focus. Both published distributions carry the same owner; no public types or package versions change.

Remove the dropdown focus hunk when an upstream release passes `ui/src/e2e/chat-attachment-focus.e2e.test.ts`, the unchanged platform attachment menu suite, and both `web-awesome-dropdown*.browser.test.ts` lifecycle suites without a consumer animation wait. These tests use real CSS animation boundaries, native keyboard input, and the actual browser filechooser; mobile identities are emulated, not native OS-picker certification. Retain the other patch owners until their respective regressions pass upstream.

The popup disposes its previous Floating UI subscription before starting another and releases the new subscription if a synchronous reposition listener disconnects or deactivates it. Remove both popup hunks when an upstream release passes the public resize/disconnect lifecycle cases in `ui/src/components/web-awesome.test.ts` without retaining resize work after removal.

`chrome-devtools-mcp@1.9.0` has an approved exact-version snapshot-identity patch, backported from [ChromeDevTools/chrome-devtools-mcp#2788](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/2788) at `06c8d4bc44f68bde8bd3fcd97dcc47375df81fe9`. Stable IDs include the frame's captured CDP session and document generation; ambiguous IDs stay capture-local, and stale lazy handles cannot resolve into a replacement renderer. Frame-local lookup and retained extra handles preserve actions and labeled screenshots. The published bundle also needs its existing `CdpFrame` export exposed. Original license notices remain intact, with modifications recorded in `build/src/OPENCLAW_PATCH_NOTICE.md`.

The published integrity is `sha512-RnzXoJiUQ44hpOihWk90uOhLD/CnwDkDy0ldHMZONJ2nYQ+dWN1fq1luHHqyd+7FuYnyIlCY6uTThbN5ut9kSQ==`; the patch SHA-256 is `832ce1d2ff002b44edb93bae88858d6edd8bc833acc87dd0fe82454d8834e340`.

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `build/src/TextSnapshot.js` | `f3496989b93d174723fcf394628fabc36936b37e6a815fd85cbe20fba46d5ea0` | `299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b` |
| `build/src/McpPage.js` | `829f11b3cb4c7b87dbb4f5b6a3f62583f4fc05746daee21e629287247debb340` | `6d83dbd4d79c913664fbfa428d138b22fe4246612ab4dfcd93e9d8e62d5d6b51` |
| `build/src/third_party/index.js` | `fc6ae43cb8f6007eba4b0f269290ec8fea6db7670686d17967b4812d90d2cc10` | `7609bb6c575c7c1152b3f4233ad4b98d97885c62ccff7bd9ee29257ca8ffc83f` |
| `build/src/OPENCLAW_PATCH_NOTICE.md` | Added | `0e53a04f337a3760f2f1adab9c20e3b4f07019795f503266c0b68e0f46d55a6c` |

The root package bundles this patched dependency so npm installations preserve the same bytes as pnpm source installs. Browser launches the packaged CLI directly with Node. Remove this patch, its registration, and the patch-specific package checks when a published upstream version passes `pnpm test:e2e:browser-mcp` and the installed-package stdio proof, including renderer replacement, cross-origin frames, cancellation, and snapshot → wait → action.

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
