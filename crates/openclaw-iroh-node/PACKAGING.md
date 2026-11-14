# Packaging recommendation (not built yet)

Status: proposal. Nothing is published, and nothing in OpenClaw loads this binding yet.

## Recommendation

Publish the binding the way napi-rs and `@number0/iroh` do: one loader package plus one npm package per
platform, attached as `optionalDependencies` of the package that runs the iroh tunnel child process,
not of the core `openclaw` package.

- Packages: `@openclaw/iroh-node` (the generated `index.js` loader and `index.d.ts`) and seven
  platform packages, `@openclaw/iroh-node-<platform>` with `os`, `cpu` and `libc` fields, so npm
  installs only the matching binary. `napi artifacts` and `napi pre-publish` produce this layout from
  the CI build artifacts.
- Targets: linux x64/arm64 for glibc and musl, darwin arm64/x64, win32 x64 (msvc). Build darwin on
  `xcode-27` and Windows on `windows-2025`. Cross-build the four Linux targets on one Linux runner
  with `cargo-zigbuild`, then load-test each on a matching runner or container.
- Publish from a release workflow with npm provenance, in lockstep with the loader version. An
  iroh bump is a one-line change to `iroh = "=x.y.z"`, a rebuild of all targets, and a rerun of
  `test/compat.test.cjs` against the matching `iroh-relay`.
- Keep the binding out of the default install path until the tunnel ships. A Linux binary is about
  10 MB (4.6 MB gzip). Users who never enable OpenClaw ID should not download it.

## Alternatives considered

| Option                                                   | Why not first                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle every `.node` file in the `openclaw` tarball      | About 70 MB raw for seven targets, paid by every install                                                                                                                   |
| Download the binary at first use, pinned by SHA-256      | A second distribution channel next to npm; offline installs break                                                                                                          |
| Wait for an upstream fix in `@number0/iroh` (`iroh-ffi`) | Best long-term outcome, but the timing is not ours, and upstream ships no darwin-x64 build. File the fix upstream anyway, and drop this package if upstream reaches parity |

## Before the first publish

- Agree on the owning package (core, a bundled plugin, or a ClawHub plugin) and its install path.
- Add a `cargo deny` license gate: one MPL-2.0 crate (`attohttpc`) comes in through iroh's default
  `portmapper` feature. Decide whether to disable that feature.
- Add release jobs: musl load tests in an Alpine container, then `napi artifacts`,
  `napi pre-publish` and `npm publish --provenance`.
