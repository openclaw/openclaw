# Lightpanda deployment provenance

These files configure an optional, externally managed engine. See the
[deployment instructions](https://docs.openclaw.ai/tools/browser/lightweight).
They do not add an engine binary, container layer, or npm dependency to OpenClaw.

## License boundary

OpenClaw's adapter is MIT-licensed. Lightpanda 0.4.1 is **AGPL**, with an
upstream declaration inconsistency: its
[licensing document](https://github.com/lightpanda-io/browser/blob/614c1640af8065b1972559abef7ca4cea06f8ba3/LICENSING.md)
says `AGPL-3.0-only`, while its
[source header](https://github.com/lightpanda-io/browser/blob/614c1640af8065b1972559abef7ca4cea06f8ba3/src/main.zig#L1)
allows version 3 or later. Preserve both pieces of evidence in the SBOM review;
do not silently choose one SPDX expression as license clearance. The
[license text](https://github.com/lightpanda-io/browser/blob/614c1640af8065b1972559abef7ca4cea06f8ba3/LICENSE)
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

Reviewed on **2026-09-21**:

- [Release 0.4.1](https://github.com/lightpanda-io/browser/releases/tag/0.4.1)
  resolves to source commit `614c1640af8065b1972559abef7ca4cea06f8ba3`.
- [SHA256SUMS](SHA256SUMS) records all four official Linux/macOS x86-64/ARM64
  binary digests. Each matched the corresponding release API digest.
- [compose.yaml](compose.yaml) pins the official multi-platform image index,
  rather than relying on the version tag alone.

| OCI object           | SHA-256 digest                                                     |
| -------------------- | ------------------------------------------------------------------ |
| Image index          | `73f67d2dc0bc243f3a8c87065c9871c98b121197baf7b650df5da91b33b98f02` |
| Linux amd64 manifest | `a20e5d4671a3c5d4af42eb41c1c451e0aa684b0ea9cfe5fa18901ad82dc9ad88` |
| Linux arm64 manifest | `c7b93852d3f40693826209e2763327199bafe50d376fa9b805d90954f8a06de3` |

Both image engine layers were downloaded and hashed without execution. Their
`usr/bin/lightpanda` contents matched the corresponding Linux binary checksums
in `SHA256SUMS`. The attached SLSA provenance identifies
[browser-docker commit `844bcb2e3df1aac108f7301edb97f8859edd7e35`](https://github.com/lightpanda-io/browser-docker/blob/844bcb2e3df1aac108f7301edb97f8859edd7e35/Dockerfile)
and build argument `TAG=0.4.1`. Neither architecture's attestation manifest
included an SPDX or CycloneDX SBOM. This observation is not signature verification
or proof of a reproducible build.

That Dockerfile's final stage copies the engine, CA bundle, and Tini; it does not
explicitly copy Lightpanda's license, source, or third-party notices. Its engine
layers contain only the executable. The sample pulls upstream artifacts directly;
it does not establish that mirroring or repackaging them satisfies redistribution
obligations.

## Existing JavaScript clients

The adapter reuses these pre-existing dependencies without changing package
manifests or the lockfile:

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

The pinned [Zig dependency manifest](https://github.com/lightpanda-io/browser/blob/614c1640af8065b1972559abef7ca4cea06f8ba3/build.zig.zon)
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
