---
summary: "The setup command (safe to repeat), Gateway-prepared runtime archives, and building a custom node package"
title: "Worker setup and bundle installation"
doc-schema-version: 1
read_when: "You are writing a profile setup command, or you need a custom node distribution."
---

OpenClaw installs its runtime automatically from the running Gateway. Profiles need only optional machine prerequisites; repository dependencies and startup commands belong in the [cloud environment file](/gateway/cloud-workers/environment-file).

## Automatic Linux Node toolchains

Linux x64 and arm64 workers need no Node installation in `settings.setup`. OpenClaw preserves a supported Node on `PATH` when npm, npx, and Corepack are available; otherwise it installs its pinned official release after SHA-256 verification. The image needs compatible glibc, `curl`, `tar`, and `sha256sum`, plus HTTPS access to nodejs.org.

Prepared repositories select their Node requirement from `.nvmrc`, `.node-version`, `.tool-versions` (`nodejs` or `node`), `mise.toml` (`[tools] node`), then `package.json` `engines.node`. Versions, majors, SemVer ranges, `node`/`latest`, and LTS aliases resolve to a matching official Linux release; `system` retains the bootstrap Node. Invalid declarations or missing releases fail with a repair hint.

Verified toolchains survive snapshot forks. Repository commands use the prepared HOME's `.local/bin` shims first. A declared `packageManager` gets user-writable Corepack shims without sudo. The OpenClaw runtime uses its own supported Node, independently of the repository's version. Custom profile Node installs remain supported. macOS and Windows need image- or setup-provided Node and npm; OpenClaw does not install them there.

## The setup command

`settings.setup` runs on a cold machine after readiness and before repository preparation and enrollment. Provision replay can repeat it, so make it idempotent. Snapshot forks skip it because their compatible image already contains its filesystem results. Use repository `postStartCommand` for processes that must start on each new worker.

Do not install OpenClaw globally or maintain a versioned runtime/plugin URL in setup. Bootstrap supplies the Gateway's runtime and required plugins. For additional packages, account for image initialization: wait for cloud-init and use your package manager's lock-wait option to avoid failing the first dispatch on a held lock. Setup or enrollment failures report an error and stop the incomplete lease.

### Protected setup secrets

Private package access uses [setup secrets](/gateway/config-cloud-workers#setup-secrets) through protected egress, including when snapshots are disabled. Keep raw credentials out of setup commands and files.

### Native Windows prerequisites

For `windows/normal`, Crabbox executes `settings.setup` with Windows PowerShell. Write setup commands for PowerShell; Linux, macOS, and Windows (WSL2) continue to use POSIX scripts. A profile with setup cannot override its OS across that interpreter boundary: OpenClaw rejects the request before allocation and omits incompatible OS and machine choices. Use a separate profile with `settings.target: "windows/normal"` and PowerShell setup for native Windows. Profiles without setup retain all backend-supported OS choices. OpenClaw does not inspect or translate scripts; you remain responsible for compatibility between POSIX targets.

For example, this prerequisite check uses the machine's existing Node and npm installation:

```powershell
$ErrorActionPreference = 'Stop'
& (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source --version
exit $LASTEXITCODE
```

Use a Crabbox bootstrap or image that supplies a supported Node.js release and npm on the machine `PATH`, with npm's CLI installed beside `node.exe` under `node_modules/npm`. OpenClaw fails enrollment with a prerequisite message if Node or that npm installation is missing; it does not install Node. npm installs the node runtime archive, and OpenClaw extracts worker bundles with its Node archive library.

Headless Windows guests must include Crabbox's managed launcher at `C:\Program Files\Crabbox\bin\Start-CrabboxDetachedProcess.ps1`. It keeps the node alive after Crabbox closes its SSH command. Enrollment fails with guidance if the launcher is absent. A hidden PowerShell parent redirects node output to `node.log` under its isolated state directory because the launcher does not inherit SSH output handles.

Desktop-enabled Windows workers use Crabbox's interactive desktop service; see [native desktop prerequisites](/gateway/cloud-workers/desktop#native-windows-prerequisites).

## Bundle installation

Before enrollment, the Gateway prepares a reusable archive from its current built installation, including the node host and trusted plugins required by the selected execution mode. Codex's plugin and managed binary pin travel with it. The archive contains runtime code and package metadata, not Gateway config, authentication profiles, sessions, or process environment.

The worker bundle includes the pinned Windows permission-inspection helper alongside its JavaScript runtime. Its bytes are covered by the same archive manifest and content verification.

Archives and successful installs are verified by content digest, rather than version alone, and reused when they match. A snapshot fork tops up an older runtime before enrollment. Native dependencies install for the destination OS and CPU, so registry access is still required; this is not an offline dependency bundle. Enrollment and archive-download credentials are not passed to npm or the node process.

Concurrent workspace installs on the same node share an in-progress integrity scan of the same already prewarmed bundle. Later requests scan the installed files again, so edits or damage still trigger repair. Retention and replacement separate scans; each request keeps its own cancellation and download credentials.

For source builds, run `pnpm build` and restart the Gateway before dispatching. Bootstrap does not compile an unbuilt checkout or copy raw edits over the running build. Missing or mismatched build metadata gives a rebuild-and-restart error. Private QA-only build chunks are excluded only when build metadata verifies their ownership; incomplete metadata or imports fail preparation.

OpenClaw worker turns install the matching worker bundle, reusing a verified archive retained in a prepared image when available. Codex remote execution starts its managed exec-server directly. Node-command allowlists and invocation approval still apply. See [runtime support](/gateway/cloud-workers/dispatching-a-session#runtime-support) and [the security model](/gateway/cloud-workers/security-model).

### Reuse a node runtime archive after Gateway restart

Linux and macOS deployment images can retain an already prepared node runtime archive as `node-runtime.tgz` in the running OpenClaw package root, beside `package.json`. During image preparation, copy the producer's archive there before closing the producer:

```bash
cp /path/to/prepared/node-runtime.tgz /path/to/openclaw/node-runtime.tgz
```

On Linux and macOS Gateways, the first preparation after restart verifies the retained archive against the running distribution, selected plugins, dependency pins, and imports. A match skips compression; a missing, unsafe, corrupt, or mismatched archive uses the normal builder. Different execution modes can require different archives. Windows Gateways use the normal builder.

Replace the retained file when the distribution or plugins change, or remove it to restore ordinary preparation. This saves archive construction, not enrollment or worker installation. Gateway shutdown removes its temporary copy after active consumers settle.

## Build a complete custom node package

Automatic cloud bootstrap does not require a manually published package. For a separate deployment or package-validation workflow, the standard package builder can still produce a complete custom distribution and explicitly include source-owned plugins that the ordinary core package excludes:

```bash
source_sha="$(git rev-parse HEAD)"
node scripts/package-openclaw-for-docker.mjs \
  --bundle-plugin codex \
  --pnpm-pack \
  --allow-unreleased-changelog \
  --output-dir .artifacts/cloud-node \
  --output-name "openclaw-cloud-${source_sha}.tgz"
shasum -a 256 ".artifacts/cloud-node/openclaw-cloud-${source_sha}.tgz"
```

Run this in a clean, trusted checkout with dependencies installed. The builder compiles the runtime, includes the selected plugin's built entrypoints and import closure, and regenerates the installation inventory. It temporarily adds the plugin's exact runtime dependency pins to the distribution manifest, rejecting conflicting or unpinned dependencies, and marks the selected plugin as distribution-owned. Source manifests and inventory are restored after packaging. Repeat `--bundle-plugin <id>` for additional source plugins. Without that option, the ordinary core package and external plugin publication contracts are unchanged.

During an update, Doctor removes eligible managed npm copies that shadow the plugin included in this distribution, even when their version strings match. Copies retained by another operation keep their existing protection. Plugin settings and data remain in the state directory. Include runtime plugins that must match an unreleased host SDK in the same custom package; a core-only archive cannot update their separately published code.

Deliver the resulting archive through your existing immutable artifact path and verify its SHA-256 before installing it with normal npm lifecycle scripts enabled. Record both source SHA and archive digest: different unreleased builds can share a version. Do not copy a plugin into an installed release or substitute a standalone `npm-pack:` plugin archive for this distribution. Cloud profiles do not consume this URL; their enrollment artifact comes from the running Gateway.

After verifying the downloaded archive, install it with the mask scoped to the root command, then verify the version as the user who will run it:

```bash
sudo sh -c 'umask 022 && npm install -g /tmp/openclaw-cloud.tgz'
openclaw --version
```

Use the path of your verified archive in place of `/tmp/openclaw-cloud.tgz`. Changing the install mask does not repair existing root-only parent directories; if an earlier install was inaccessible, correct access to that package and its parent directories before retrying enrollment.

Native dependencies are declared at the distribution root and installed for the target operating system and CPU; the archive does not copy the build host's plugin `node_modules`. Target installation still needs registry access and is not an offline dependency bundle. Verify each target architecture you deploy. Use `--skip-build` only when reusing a complete build from that same source revision with all selected plugin outputs present.
