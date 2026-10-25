# Lightpanda deployment provenance

These files configure an optional, externally managed engine. See the
[deployment instructions](https://docs.openclaw.ai/tools/browser/lightweight).
They do not add an engine binary, container layer, or npm dependency to OpenClaw.

## License boundary

OpenClaw's adapter is MIT-licensed. Lightpanda 1.0.2 is **AGPL**, with an
upstream declaration inconsistency at its selected source commit: its
[licensing document](https://github.com/lightpanda-io/browser/blob/c5f7bb29b127040c899d4e181b5709f76fc71a6f/LICENSING.md)
says `AGPL-3.0-only`, while its
[source header](https://github.com/lightpanda-io/browser/blob/c5f7bb29b127040c899d4e181b5709f76fc71a6f/src/main.zig#L1)
allows version 3 or later. Preserve both declarations during redistribution
review; neither makes the engine permissively licensed. The
[license text](https://github.com/lightpanda-io/browser/blob/c5f7bb29b127040c899d4e181b5709f76fc71a6f/LICENSE)
is AGPL version 3.
The engine is independently installed and communicates with OpenClaw over CDP;
OpenClaw does not link, vendor, or relicense its implementation. This is not an
MIT-only stack or a certification that every deployment is legally compliant.
Do not select Lightpanda when your policy excludes copyleft software.

Before redistributing a binary or image, review AGPL sections 4–6, preserve
notices, and provide the required complete Corresponding Source. Before serving
a modified engine, also review section 13's network-source requirements.
Third-party and container-package obligations remain separate. A process or
socket boundary alone does not decide whether software forms an independent
work; see the [GNU aggregation guidance](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation).

## Artifact integrity

Updated on **2026-10-23**:

- [Release 1.0.2](https://github.com/lightpanda-io/browser/releases/tag/1.0.2)
  was published on **2026-10-23 at 09:01:02 UTC** and resolves to source commit
  `c5f7bb29b127040c899d4e181b5709f76fc71a6f`.
- [SHA256SUMS](SHA256SUMS) records all four official Linux/macOS x86-64/ARM64
  binary digests from the release API. The downloaded Linux x86-64 binary also
  matched its checksum before execution and reported version 1.0.2.
- [compose.yaml](compose.yaml) pins the official multi-platform image index,
  rather than relying on the version tag alone. The index bytes matched the
  registry's content digest; its platform configurations were created on
  **2026-10-23 at 09:04:39 UTC** (amd64) and **09:04:40 UTC** (arm64).

| OCI object           | SHA-256 digest                                                     |
| -------------------- | ------------------------------------------------------------------ |
| Image index          | `5d1d724c476957d8c2f8393a51fd089477523b0e5aa9c783c48688785d934fb9` |
| Linux amd64 manifest | `0fd590f7072f15ff8f681b546bdda231a9f1d65360da27376c02cb72b2a0413e` |
| Linux arm64 manifest | `94b7a6c97648a68a0905ea6f225b7ee36ba75b51bc6c6d5427f523f803f8e572` |

The amd64 image's attached SLSA provenance identifies
[browser-docker commit `4b9d558e5598f825b4e5fe469370c4ff6a3adb46`](https://github.com/lightpanda-io/browser-docker/blob/4b9d558e5598f825b4e5fe469370c4ff6a3adb46/Dockerfile)
and build argument `TAG=1.0.2`. This inspection is not signature verification,
proof of a reproducible build, or a complete binary SBOM review.

That Dockerfile's final stage copies the engine, CA bundle, and Tini; it does not
explicitly copy Lightpanda's license, source, or third-party notices.
The sample pulls upstream artifacts directly;
it does not establish that mirroring or repackaging them satisfies redistribution
obligations.

## Adapter verification

The unmodified `extensions/browser/scripts/bench-lightweight.ts` fixture passed
with the checksum-verified 1.0.2 Linux x86-64 binary and the repository-pinned
Playwright 1.64.0 client: one initial task and two warm tasks covered navigation,
efficient AI snapshots with references, typing, clicking, exactly-once form
submission, waiting, and text extraction. Unsupported capabilities still
returned 501, a second page was rejected, and disconnecting invalidated the old
target. No adapter or browser security policy changes were needed. The engine's
default CORS enforcement remains enabled.

A separate local fixture moved the Save button into an open shadow root. Its
reference resolved, but the OpenClaw click failed in Playwright's hit-target
check with `root.elementsFromPoint is not a function`. Lightpanda 1.0.2's
upstream mouse-event improvements therefore do not establish shadow-DOM click
support with this client. No forced click, page polyfill, or action replay was
used to bypass the failure. Keep Chromium for affected sites.

All runtime checks used isolated state and engine processes, not an existing
browser, Gateway, profile, or user state. Docker route execution, Windows,
Linux ARM64, and both macOS architectures remain unverified by this update.
The other three native binary pins were checked against release API digests,
without download or execution.

The retained adapter observations above do not qualify this version's Compose
WebSocket-readiness probe, independent probe-session close, crash restart, or
SIGTERM/stop-grace behavior. Those container-specific checks require execution
against the exact pinned image; historical 0.4.1 results are not proof for the selected image.

## Existing JavaScript clients

The following client inspection records the **2026-09-21** audit. Current client
versions and integrity are owned by the package manifests and lockfile; selecting
the external engine does not add a JavaScript dependency:

| Package                                                              | Version | License    | Verified npm tarball integrity                                                                    |
| -------------------------------------------------------------------- | ------- | ---------- | ------------------------------------------------------------------------------------------------- |
| [playwright-core](https://registry.npmjs.org/playwright-core/1.63.0) | 1.63.0  | Apache-2.0 | `sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==` |
| [ws](https://registry.npmjs.org/ws/8.21.3)                           | 8.21.3  | MIT        | `sha512-201TZ/kPWxoPr/OKWjquZR1SWKXcvxdH+e1xrx89b3YbmzLMFCLfnaG1HFIgWzJOEWZ7MvpK++odZufgYR50Rw==` |

Downloaded tarball SHA-512 values matched `pnpm-lock.yaml`. Playwright's package
also bundles 79 npm components, including its own `ws` 8.21.0, plus a WebP codec.
Ordinary npm dependency traversal does not inventory this inlined code.
Preserve its `LICENSE`, `NOTICE`, `ThirdPartyNotices.txt`, and `lib/*.LICENSE`
files, including the libwebp/Emscripten notices. Preserve `ws`'s `LICENSE` too.
Permissive dependencies can accompany an MIT project without becoming MIT-only.

## Engine dependency scope

The 1.0.2 [Zig dependency manifest](https://github.com/lightpanda-io/browser/blob/c5f7bb29b127040c899d4e181b5709f76fc71a6f/build.zig.zon),
[build-tool versions](https://github.com/lightpanda-io/browser/blob/c5f7bb29b127040c899d4e181b5709f76fc71a6f/.github/actions/install/action.yml),
and [Rust lockfile](https://github.com/lightpanda-io/browser/blob/c5f7bb29b127040c899d4e181b5709f76fc71a6f/src/rust/Cargo.lock)
identify the current source dependencies. The Rust lockfile contains 105 registry
packages. The source pins V8 15.5.35.13, nghttp2 1.70.0, curl 8.23.0, zstd 1.5.7,
PCRE2 commit `9ad4a2e956876747a5022bf04614c7e39e71d4ec`, and several other
source-pinned components. The older license inventory below is
historical evidence, not a renewed review of this release's dependency closure.

### Historical 0.4.1 dependency audit

The previously inspected [Zig dependency manifest](https://github.com/lightpanda-io/browser/blob/614c1640af8065b1972559abef7ca4cea06f8ba3/build.zig.zon)
and [build-tool versions](https://github.com/lightpanda-io/browser/blob/614c1640af8065b1972559abef7ca4cea06f8ba3/.github/actions/install/action.yml)
identify these components. This table is a source-level inventory, not a complete
binary SBOM or a replacement for their notices.

| Component            | Pin                                               | License evidence                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BoringSSL            | `535cc391915c37912ff9b3edb0cff9b3c5c77db0`        | [Apache-2.0 root](https://github.com/google/boringssl/blob/535cc391915c37912ff9b3edb0cff9b3c5c77db0/LICENSE) and [Zig wrapper](https://github.com/lightpanda-io/boringssl-zig/blob/f07cc58fa4a051eb0985287e691db5dbb0e7e76f/LICENSE); third-party terms remain separate |
| Brotli               | 1.2.0, `028fb5a23661f123017c060daa546b55cf4bde29` | [MIT](https://github.com/google/brotli/blob/028fb5a23661f123017c060daa546b55cf4bde29/LICENSE)                                                                                                                                                                           |
| curl                 | 8.22.0                                            | [curl license](https://github.com/curl/curl/blob/01346829096c61b372692f6dc43ffa778c6caccd/COPYING)                                                                                                                                                                      |
| isocline             | `ec538faf435c616a6b38716f53980b5815c30f8a`        | [MIT](https://github.com/arrufat/isocline/blob/ec538faf435c616a6b38716f53980b5815c30f8a/LICENSE)                                                                                                                                                                        |
| nghttp2              | 1.69.0                                            | [MIT](https://github.com/nghttp2/nghttp2/blob/68cb6900fde14c77f0cd7add0e094a862960eb99/COPYING)                                                                                                                                                                         |
| PCRE2                | 10.48                                             | [BSD-3-Clause WITH PCRE2-exception](https://github.com/PCRE2Project/pcre2/blob/7978954dbd2efc6f2196869290553cf1871b4ce6/LICENCE.md)                                                                                                                                     |
| SQLite build wrapper | `7a615f5af79009cd733e3480658586d9b0d28b35`        | [MIT wrapper](https://github.com/allyourcodebase/sqlite3/blob/7a615f5af79009cd733e3480658586d9b0d28b35/LICENSE); SQLite's own terms are separate                                                                                                                        |
| V8                   | 14.9.207.35                                       | [BSD-style root and separately licensed components](https://github.com/v8/v8/blob/933ce636c562cd54d68e7f7c93ab5cdffd685fca/LICENSE); [MIT Zig wrapper](https://github.com/lightpanda-io/zig-v8-fork/blob/31b233ce6162c18eb37cacd001473057f75daad9/LICENSE)              |
| zenai                | `be5d2e70d3dcc9866041dbdbcfa1f18799601a30`        | [Apache-2.0](https://github.com/lightpanda-io/zenai/blob/be5d2e70d3dcc9866041dbdbcfa1f18799601a30/LICENSE)                                                                                                                                                              |
| zlib                 | 1.3.2                                             | [Zlib](https://github.com/madler/zlib/blob/da607da739fa6047df13e66a2af6b8bec7c2a498/LICENSE)                                                                                                                                                                            |

The [Rust lockfile](https://github.com/lightpanda-io/browser/blob/614c1640af8065b1972559abef7ca4cea06f8ba3/src/rust/Cargo.lock)
contains 105 registry packages. All pinned versions' crates.io license metadata
was checked: declarations use permissive families including MIT, Apache-2.0,
BSD, Zlib, and Unicode-3.0, sometimes in combination. Metadata review does not
verify every file in those crates. The bundled fonts have their own
[Bitstream/DejaVu/Arev notices and naming conditions](https://github.com/lightpanda-io/browser/blob/614c1640af8065b1972559abef7ca4cea06f8ba3/src/rust/render/fonts/LICENSE).

This review does **not** cover all OpenClaw dependencies, V8's complete third-party
closure, platform system libraries, Debian image packages, or availability of
complete Corresponding Source for every distributed artifact. Recheck these
boundaries and pins when changing the engine version or distribution model.
