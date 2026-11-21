# Temporary dependency patches

Keep existing insertion anchors when extending these patches: pnpm 12 can apply a zero-context, zero-length insertion one line early. After regeneration and installation, verify installed files against the patch's target blob hashes before testing.

`acorn@8.19.0` has an approved optional-member token-context patch. Keywords
and contextual names (`of` and generator `yield`) after `?.` end a property
access, just as after `.`, so a following slash remains division. Both published
module formats are regenerated from upstream commit
`0e0ece7cc7202624d4aca531be4b515b0114b5d0`. In `acorn/src/tokencontext.js`,
extend the keyword property's `tt.dot` condition to `tt.questionDot`, and exclude
`tt.questionDot` alongside `tt.dot` in `tt.name.updateContext`. In
`acorn/src/expression.js`, keep `parseIdentNode` from popping a `class`/`function`
context after either member operator, since neither now pushes one. Run upstream's
`npm run build:main` with its locked Rollup 4.60.1 and
`@rollup/plugin-buble@1.0.3`, copy the two generated runtime files into a
`pnpm patch acorn@8.19.0` edit directory, then use `pnpm patch-commit`.
The unmodified build reproduces the published runtime hashes below exactly.

The published integrity is
`sha512-oJlA3XiRm7Cyk6qFD2Jn8ak9B7jSy0qy00ADO3+8dpT0LSjFihQYv4C02LFCSYJV3Q37xYwwRy5m+IpIiUzqWw==`;
the patch SHA-256 is
`2abf815a7e66bb39548d0a14081a6fde06f22eb1f6b5bd5f242d4c11a66db77a`.

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/acorn.js` | `b95392d79457d0357555c5ed3e56302d074b92dff119bcf3b44179500b10e9df` | `31913109325741386772ce3470877ba1ecc3d0ffb95211e34cab7c9a504c8543` |
| `dist/acorn.mjs` | `76254fc76529713b4dfd2532972d17a991ffd9aafeebb1f977445b5506b9fb0b` | `d6ec452ae1a66ac40815ddf44bb88d0c46389c14cc0d48766772f0f058a02451` |

The root package bundles Acorn so npm installations retain the patched runtime.
Codex explicitly bundles only Acorn while retaining its native-heavy full-closure
opt-out; the shared npm/ClawHub packaging owner preserves that selected patch.
Remove this patch, its registration, Acorn bundle entries, and exact-version guard when
an upstream release passes `src/agents/code-mode-engine-parity.test.ts` and the
existing syntax/module-access controls without the patch. Upstream commit
`e4516ce0f49aea06b98ae1a551644119958ed4e1` still has both ordinary-dot-only guards.
Acorn's contribution policy excludes AI-written code; do not submit this patch
upstream as a generated contribution.

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

`chrome-devtools-mcp@1.12.0` has an approved exact-version snapshot-identity patch, backported from [ChromeDevTools/chrome-devtools-mcp#2788](https://github.com/ChromeDevTools/chrome-devtools-mcp/pull/2788) at `06c8d4bc44f68bde8bd3fcd97dcc47375df81fe9` and forward-ported onto tag commit `af2834411a564d366f9cab63efb046d9084f4dba`. Stable IDs include the frame's captured CDP session and document generation; ambiguous IDs stay capture-local, and stale lazy handles cannot resolve into a replacement renderer. Frame-local lookup and retained extra handles preserve actions and labeled screenshots. The 1.12.0 CSS-style lookup resolves the same guarded handle and stays within its captured renderer, failing closed when the embedded DevTools target cannot represent a cross-renderer frame. Version 1.12.0 already exports its bundled `CdpFrame`, so the patch changes only the snapshot owner and its DOM-result caller. Original license notices remain intact, with modifications recorded in `build/src/OPENCLAW_PATCH_NOTICE.md`.

The published integrity is `sha512-lAGpH0zXT1ZdaPefP1KK/MvxwihOlu7VGQ7p4wbhD9OhN17vUC4KWk/ImUYR9DE4s+7r4r0ySV4xr2OkTa7ZMA==`; the patch SHA-256 is `1512760e206b35bf417387b18d4c1a5d0f68e2ffeef994cb733c9e02ba4eba92`.

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `build/src/McpPage.js` | `70f22c6f6d4e721e001de5167d4dab7b012b4c024d5e5d89b480c85c1c2a163a` | `313ce4bfaaea85ab3c57a0bb8f4ad23c093ad33f25407170b2bef6f1654b30b8` |
| `build/src/OPENCLAW_PATCH_NOTICE.md` | Added | `c490fb032360cf26141c4a8d72c6ab4587613051619aa88c346662eaaa6daee5` |
| `build/src/TextSnapshot.js` | `a8d830eebe70a4a0dda162d24e1ef5c83d334b09b72b6491e8ddd380da76e9c4` | `21be06826da0dafaadf712b1dc689f6f07c63042a0b6ee30c4afca9a0d616963` |
| `build/src/third_party/index.js` | `e1752f75684b672362dc3ae77a399407c509b76471fca08f967fc44fe2cb267b` | Unchanged |

The root package bundles this patched dependency so npm installations preserve the same bytes as pnpm source installs. Browser launches the packaged CLI directly with the runtime running OpenClaw, Node or Bun. Remove this patch, its registration, and the patch-specific package checks when a published upstream version passes `pnpm test:e2e:browser-mcp` and the installed-package stdio proof, including renderer replacement, cross-origin frames, cancellation, and snapshot → wait → action.

`@novnc/novnc@1.7.0` has an approved temporary patch for ignored extended-clipboard payloads. The RFB owner consumes the remaining compressed bytes before returning for view-only clients or unsupported clipboard formats. It does not inflate or publish ignored clipboard data, and controlling text clipboard handling stays unchanged. This keeps clipboard bytes from becoming the next RFB message and disconnecting WebVNC.

Remove the noVNC patch, its registration, and its exact-version guard exception when an upstream version passes the Desktop panel and document browser suites (`test/vitest/vitest.ui-e2e.config.ts`) and the live view-only selection/type stress check. The regression uses the real noVNC parser, covers coalesced and fragmented payload delivery, and requires the next framebuffer update without a reconnect.

`matrix-js-sdk@44.0.0` has an approved temporary patch for saved-sync verification replay. Classic sync propagates its existing cache provenance through ordinary client events, and the crypto listener ignores restored events. This preserves room history, sync cursors, ordinary event listeners, fresh verification events, and to-device processing while preventing cached verification requests from restarting after a clean client shutdown. Version 44.0.0 still routes restored events into crypto, so the patch remains necessary.

The same Matrix patch unrefs request deadline timers so finished CLI commands can exit, and catches late in-room verification failures after client shutdown instead of leaving an unhandled rejection. These are independent of saved-sync replay; retain them until `extensions/matrix/src/matrix/sdk/matrix-js-sdk-patch.sdk.test.ts` passes with the unpatched dependency.

The published integrity is `sha512-5wjcYMIX1aqhJC9hSUGjfSW+7SWEaLC8NUaek0xH5KGXqAO11M4Z5Mk7Voodsk+16Jm9PYB8/wMtyqIKFm0VAQ==`; the patch SHA-256 is `823022214a1466879aba6c60460809768e76f747411fd95c8a99d56096100f48`.

Remove the Matrix patch, its registration, and its exact-version guard exception when an upstream release passes `node scripts/run-vitest.mjs extensions/matrix/src/matrix/client/file-sync-store.test.ts` and the full Matrix QA catalog, including the original DM SAS-to-QR sequence. The regression exercises the real SQLite sync store, SDK cache hydration, and crypto event wiring; it observes crypto input rather than substituting for native verification proof.

`vitest@5.0.5` has one approved exact-version pnpm patch. Vitest 5 bundles the
runner, and `@vitest/runner@5.0.0` is not published, so no standalone runner
dependency or patch remains. The published package integrity is
`sha512-cPODOMF8YnkiiYtDdHo6n4wWmBrOBBbOIYH2d33M4l3CdNn72h+qMmO6uXffUN6A5AZFXNND/d+krS9mgkXRfg==`.
The patch SHA-256 is
`af34f8b20f312ef2483070dc17cd9ca5127e14947d9a8a190682daca360c13fc`
and it changes exactly these eleven published files:

| Target | Published SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/chunks/cac.CLrZKo1g.js` | `cbe6e023d5b1e5c8de648da0d43242e660d88676b172a022d2b95f22a88b78c0` | `5c429f733a64ee9a0de35db6fe15f5ee10d03ae784f664faf0afe940896ad7fb` |
| `dist/chunks/cli-api.De07GUeT.js` | `8b75d08fd468ac1428ef5562e43883e2cf1953c8953a7eab95da17b30ed97945` | `39173bec8f75564cd8db538593973cdf101a8321fd2a9c26d9d5edfa6ac3af53` |
| `dist/chunks/index.1TqnEahn.js` | `4e311af8b4db378a5c3d4e768b5210b0779d2ae0d0ec05f81a72378dbaf25412` | `5e145f05fb6a3626b30ecdb984b993380915b03c1ba580b60ee58d3603979d5b` |
| `dist/chunks/index.CK-t0WMg.js` | `4712d1e9acaefca5d215c21f53007eeae30904768d45a10cd1fd09c01c6fd46e` | `605c675633a59166e5ca9b04108f4b34ca9f3cf2e3cc41a292f8277ec64aaa99` |
| `dist/chunks/index.aTZaPVhf.js` | `381472b0170386acbc3f7d05b68ef05b3da53dcaa1058d2750d138648cd2933a` | `9fed49edda9cac115628ff4203ca307200ff721786925654044fbe4076be5ad9` |
| `dist/chunks/init.PvxYpuCm.js` | `c0f37bd5e2230b47784675ecdb4d915a7df0a2100eadcc80fca99dab30013148` | `d844ad0dc35cc54bcad3041fa894fbc101de2c0d75193fb5dc4ce9842102c7f7` |
| `dist/chunks/init-forks.CRxIPOJR.js` | `ef3f4026f3bc661f0542e379186637000cd2e6721e78733a4d5b5e9d3de46a64` | `03632dcb32e05236d984c58f2c8aed1a3eac7cb945594e9e0bd8bb32b2a18316` |
| `dist/chunks/plugin.d.C8mmycim.d.ts` | `e1eae7448953ae3951958097b083af35b50f3adc39f0a922baa14de48324ac2f` | `59aed92bfefac4243398514cd6b274dab1ddc8841ed834d63eef6ff29d625bb7` |
| `dist/chunks/run.BPv-BBRv.js` | `6353810fdd2b6370386dfb80ec4d1415b2a12d83e00f3ebee83cc0304d6e4c6b` | `0d1eb0c41c32a0e3040d108efc634fc405b1a2c437ca3414a284d84929c59199` |
| `dist/module-evaluator.js` | `1390c7d62f1174924bdae333d59734acd065983b9f9580bdd24b07b52e430a50` | `dbb389c28c3595144ecf462a3b8e0b572780ed59caa5be3695e4d2e8c7c1ce47` |
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
- **Current environment deletion (`init.PvxYpuCm.js`, `dist/module-evaluator.js`):**
  string-key deletion and membership resolve the current `process.env`, just as
  existing reads and writes do. This includes `vi.stubEnv(key, undefined)` and
  `vi.unstubAllEnvs()` restoring an originally absent key after an environment
  replacement. Deleted `DEV`/`PROD`/`SSR` keys still read as `false`; non-string
  keys retain the proxy's ignored-key policy. Keep enumeration and descriptors
  target-owned: a stale non-extensible target cannot report replacement-only
  keys, and a replacement's non-configurable descriptor may conflict with the
  target. `Object.keys` and spread remain valid and read current values for
  captured keys, but do not promise the replacement's key set. Remove these
  hunks when a Vitest release forwards `deleteProperty` for this proxy and
  `test/scripts/vitest-import-meta-env.test.ts` passes unpatched.
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
- **Cached-source decoding (`index.1TqnEahn.js`):** decode transform-cache files as
  UTF-8 before splitting their source maps. Remove this hunk when the published
  dependency reads cached source as text and passes the cache-generation
  regressions in `test/vitest-performance-config.test.ts`.
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

`baileys@7.0.0-rc14` contains two independent repairs. Its adapter for `audio-decode@3.12.0` must
read the first decoded channel from `channelData[0]` and require the matching
3.x peer. Version 3 returns raw channel arrays instead of an AudioBuffer;
Baileys otherwise catches the missing `getChannelData()` method and silently
omits voice-note waveforms. The existing Baileys owner retains waveform
normalization, media preparation, and best-effort decoding errors.

The patch SHA-256 is
`c3c4601486630c689ffd1a0e7a34f4b8cf8e7231e41c312ad33afdf4487d8ded`.
The regression in `extensions/whatsapp/src/baileys-audio.test.ts` prepares a
real Baileys voice-note payload from deterministic PCM and checks its complete
64-byte waveform. Isolated dependency proof also covered Buffer, file, and
stream decoding, WAV and Ogg Opus voice payloads, and malformed-audio handling.
The plugin package owner bundles patched runtime dependencies so installed
WhatsApp plugins retain the adapter. Remove this patch and its registration
when an upstream Baileys version accepts the current decoder and passes the
same voice-note regression. The upload repair also selects the existing Node HTTP
uploader on Bun, preserving configured proxy agents and replayable redirect
bodies, and keeps diagnostics for upload errors without a stack. Retire that
part only when unpatched Baileys passes
`extensions/whatsapp/src/session.media-upload.test.ts` on Node and supported Bun;
an audio-only upstream fix does not replace the upload contract.

`ghostty-web@0.4.0` releases the selection manager’s document mousedown
listener and retained target on disposal. It also adds an optional terminal
`onCopy` callback after clipboard writing succeeds, including the fallback path.
The Control UI uses that success notification for copy feedback; selection
changes alone do not prove that anything reached the clipboard.

Remove this patch and its registration when an upstream release releases the
listener and supplies equivalent success-only copy feedback, with
`ui/src/e2e/terminal-runtime.e2e.test.ts` and
`ui/src/components/terminal/terminal-controller-lifecycle.test.ts` passing. Keep
failure, pending-copy and disposal cases; a copy-request callback is not the same
contract as clipboard completion.

`@shinyoshiaki/binary-data@0.6.1` uses ordinary closures for its finite numeric,
stream, transaction, and BufferList methods instead of compiling functions at
module initialization. This keeps the existing codec API and endian, byte-count,
fragmented-read, and transactional-consumption behavior while allowing the
OpenAI realtime WebRTC transport to load with JavaScript string compilation
disabled. No runtime globals or werift call sites are patched.

The patch SHA-256 is
`231e04c1ca6a2f66dda30dfe23c1178d2df9fbc2161d9eac7689e3a751a85a9b`.
Remove this patch and its registration when an upstream dependency release
passes `extensions/openai/realtime-binary-codecs.test.ts` unmodified. The test
covers all numeric codec wire bytes and fragmented transactional reads, plus a
real werift DTLS handshake and encrypted application-data exchange over an
in-memory datagram transport, with string compilation disabled throughout.

`@openclaw/crabline@0.2.0` uses fixed generated protobuf codecs for Feishu frames instead of building codecs from a reflected schema on first use. The protobuf wire format, required fields, decimal uint64 IDs, object conversion, and private schema ownership are unchanged. The runtime imports only `protobufjs/minimal.js`; no dynamic-code-generation setting is required.

The patch includes the canonical `dist/src/servers/feishu-wire.proto` plus `dist/src/servers/generate-feishu-wire.mjs`. Regenerate in the extracted package with `node dist/src/servers/generate-feishu-wire.mjs` (the generator uses pinned protobufjs-cli 2.7.0 and protobufjs 8.8.0 at build time). The original reflection source map is removed with its source-map reference rather than shipping incorrect debugger mappings. Existing public declarations remain unchanged; the new codec is an internal JavaScript module.

Remove this patch and its registration when an upstream release passes `extensions/qa-lab/src/crabline-feishu-wire.test.ts`, including the real installed dependency round trip under Node's string-code-generation ban. The synthetic fixtures cover uint64 values beyond JavaScript's safe-integer range, negative int32, UTF-8 headers, arbitrary payload bytes, optional fields, unknown fields, malformed/truncated frames, and invalid IDs. They make no live Feishu or Gateway request.

The owning plugin manifests bundle these patched runtime dependencies. Selected-plugin distributions carry those bundle declarations and their installed dependency closures into Docker and node artifacts; the default core package does not gain optional media or QA dependencies.
`playwright-core@1.64.1` has an approved syntax-only normalizer patch. Acorn
parses serialized callbacks in the same function-body grammar instead of
constructing a host Function. Execution remains in the target browser; ordinary
functions, method shorthand, and async methods retain Playwright's normalization.
The package extension supplies Acorn, and the root and browser plugin packages
bundle the patched runtime for npm installs. Remove the patch, extension, and
exact-version guard when upstream passes the browser serialization regression
with host string compilation disabled.

The same Playwright patch removes graceful-fs's obsolete process-wide `cwd` and
`chdir` cache. Importing the browser runtime leaves those functions owned by the
host, and relative filesystem access continues to use the native implementation.
The remaining graceful-fs behavior and L7's syntax normalizer are unchanged.
Upstream follow-up: [graceful-fs](https://github.com/isaacs/node-graceful-fs) should
remove this historical process polyfill, then
[Playwright](https://github.com/microsoft/playwright) can refresh its bundled copy.
Remove this hunk when `extensions/browser/src/browser/playwright-import.test.ts`
passes with the published dependency.

`@homebridge/ciao@1.3.12` adds an explicit `@homebridge/ciao/native.js` entry that
does not install source-map-support. The historical root entry retains its
published behavior. Responder diagnostics accept an optional typed logger;
custom loggers receive separate responders, while default responder pooling is
unchanged. Bonjour uses this entry and its existing plugin logger instead of
replacing process-wide console functions. The published JavaScript, declarations,
and source maps were regenerated from the upstream v1.3.12 TypeScript source.

Upstream follow-up: offer the native-source-map entry and per-responder logger to
[homebridge/ciao](https://github.com/homebridge/ciao). Remove the patch and its
registration when an upstream release supports both contracts and passes
`extensions/bonjour/src/ciao-runtime.test.ts` and `advertiser.test.ts` without the
patch. The root and Bonjour packages bundle the patched dependency so npm installs
and installed plugin artifacts retain the same entry and logger behavior as source
installs.

`proper-lockfile@4.1.2`, used by Crabline's recorder, uses native `node:fs` and
installs its own exit/signal listeners only while locks are held. Importing it
no longer loads graceful-fs or signal-exit's process-method wrappers. The
cleanup owner preserves application signal handlers, signal-exit v3/v4 observers
and vetoes, separately installed lockfile copies, and the original termination
signal. Release and compromise remove listeners when the last lock is gone.

Upstream follow-up: submit the native-fs default and owned cleanup to
`moxystudio/node-proper-lockfile`; keep the existing custom `fs` option. Remove
this patch and its registration when an upstream version passes
`extensions/qa-lab/src/proper-lockfile-runtime.test.ts`, including Crabline
recorder writes, import identity, contention, stale recovery, compromise,
normal exit, and signal cleanup. Its package file list explicitly retains the
published changelog during patch regeneration. The existing Crabline package
patch is unchanged.

`@clawdbot/lobster@2026.10.1` has an approved temporary validation patch. Its two
fixed LLM payload/envelope checks are generated with Ajv at build time. A scoped
compiler callback lets the OpenClaw plugin use the shared codegen-free validator
on AOT hosts while keeping native Ajv validation on Node and JIT Bun. The scope
belongs to one async tool request; schema caches remain separate for each native
Ajv owner. No process-global engine setter or format-registry write is added.

Regenerate fixed checks inside a `pnpm patch` edit directory with
`pnpm lobster:validators:gen --package-dir <directory>`, then run
`pnpm patch-commit <directory>`. `pnpm lobster:validators:check` checks the installed
patch without editing `node_modules`. The generator owns the generated file;
never edit its patch hunk directly.
The generated header records the Ajv version and canonical Unicode helper hash;
the existing CI generated-validator gate checks both through `pnpm validators:check`.

Normalize pnpm's trailing header tabs, then refresh the native patch hash:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const patch = "patches/@clawdbot__lobster@2026.10.1.patch";
const source = readFileSync(patch, "utf8");
writeFileSync(patch, source.replace(/^(?:---|\+\+\+) .+\t$/gm, (line) => line.slice(0, -1)));
JS
pnpm install --fix-lockfile
pnpm lobster:validators:check
```

Upstream follow-up: port the generated fixed checks and request-scoped compiler
hook to [openclaw/lobster](https://github.com/openclaw/lobster), then remove this
patch and its exact-version guard when a published version passes the Lobster
runner validation suite and the AOT/codegen-ban probe without the patch.
