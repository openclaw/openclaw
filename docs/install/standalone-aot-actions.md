---
title: "Experimental AOT Actions artifacts"
summary: "Build a manually enabled unsigned emitted-JS AOT experiment without changing releases"
---

The `Experimental macOS 27 AOT artifact` workflow is disabled by default. It creates an
unsigned **macOS 27-only**, arm64 emitted-JS AOT directory in Actions, retained for seven days.
It does not change the Mac app, JIT release pipeline, signing, notarization,
GitHub Releases, or appcasts. A failed build produces no accepted AOT artifact;
ordinary JIT releases continue independently. The workflow never silently builds
JIT in place of AOT.

The workflow builds the exact trusted `main` commit at dispatch (`github.sha`);
there is no caller-selected source ref or second checkout. The main-only job
condition and pinned checkout keep the helper and application on that same commit.
Build preparation fixes `GIT_COMMIT` to that full SHA and
`OPENCLAW_BUILD_TIMESTAMP` to that commit’s UTC committer time (`.000Z`), removing
wall-clock drift in build metadata. This does not establish bit-reproducible
compiler or executable output. Both
macOS deployment-target variables are `27.0`. The pinned compiler and its
generated executables have an actual Mach-O minimum OS of **27.0** (compiler
SDK 27.2). The workflow checks `LC_BUILD_VERSION` with `vtool` before using the
compiler and before uploading its output; the descriptor records the actual
minimum OS and SDK. Setting an environment variable does not lower a linked
binary’s minimum OS. This experiment does **not** support the Mac app’s macOS
15.0 floor. A separately built and qualified compiler profile is required for
that release target.

The workflow uses the existing [standalone builder](/install/standalone), including
its complete default plugin selection. C2, original-TypeScript, Intel, Linux,
and universal application packaging are outside this first workflow. Successful
version/help smoke is a packaging check, not full runtime qualification.

Before enabling a run, supply a compiler bundle already retained by a successful
`main` push/manual Actions run in this repository. No toolchain producer workflow
or compiler release is created here. Snapshot tags do not create binary download
URLs. The compiler is the standard qualified Bun `fd40ba44187c721ee023062fa153a6a27560e6b1`
with WebKit `aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8`; its executable SHA256 must be
`d9e1bbfd8e298c8d51bd1c5fe7a106827119355bff2b88528aa69cf823202c95`.

The selected Actions artifact contains one file, `toolchain.tar.gz`. Its gzip tar
contains only regular files/directories under `toolchain/`; links and special
files are rejected. Include `toolchain/bin/bun` and the compiler's required
adjacent resources with their original relative layout, plus this exact
`toolchain/manifest.json`:

```json
{
  "schemaVersion": 1,
  "bunCommit": "fd40ba44187c721ee023062fa153a6a27560e6b1",
  "webkitCommit": "aaa690bfbf34c9d50775716ac2fc3c7d0573e0b8",
  "profile": "standard",
  "platform": "darwin",
  "arch": "arm64",
  "executable": "bin/bun",
  "executableSha256": "d9e1bbfd8e298c8d51bd1c5fe7a106827119355bff2b88528aa69cf823202c95"
}
```

Record the actual bundle SHA256 and Actions run/artifact IDs. Dispatch
`aot-artifacts.yml` from `main` with `enable_aot=true`, those three identities,
and `min_memory_gib` selected
from measured JS build peak plus headroom. The experiment uses the existing
`xcode-27-xlarge` tier; the repository documents the standard `xcode-27` runner as
3 CPUs with 7 GB RAM. The larger label alone does not establish sufficient RAM
for AOT. There is no measured threshold default: inspect the
retained host report and select sufficient physical RAM before dispatch.
The job requires a macOS 27 or newer runner and rejects native architecture mismatch, insufficient physical RAM, or
less than 25 GiB free on either internal or output storage. Memory pressure is
recorded as an observation, not interpreted as exact free memory.

Evidence includes exact source/compiler identities, runtime/UI/AOT phase wall and
CPU time, one-second sampled process-tree peak RSS, and Darwin `time -l` output.
The sampled tree peak is a lower bound; short-lived peaks may be missed. The
artifact is a tar archive that preserves permissions and sidecar symlinks; it
includes `openclaw`, `runtime/`, `manifest.json`, and an explicit unsigned
experiment descriptor. Keep the full directory together. Do not install it over
a production app or use it as notarized distribution evidence.

Interrupted measurement receives SIGTERM, records failure evidence, and stops
its dedicated process group. SIGKILL or loss of the runner cannot preserve a
final receipt; the Actions run remains the authority for an interrupted job.

The `macos27-only` artifact name is intentional. Version/help smoke on the build
host does not qualify other macOS versions or every native sidecar operation.
