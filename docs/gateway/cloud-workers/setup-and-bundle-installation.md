---
summary: "The setup command (safe to repeat), Gateway-prepared runtime archives, and building a custom node package"
title: "Worker setup and bundle installation"
read_when: "You are writing a profile setup command, or you need a custom node distribution."
---

What runs on the leased box before enrollment, how the Gateway prepares and verifies the runtime archive it installs there, and how to build a complete custom node package.

## The setup command

Crabbox coordinator transport timeouts before profile setup, node runtime preparation, or node enrollment scripts start allow up to three attempts with backoff, within the existing phase budget. Only output consisting entirely of coordinator timeout diagnostics qualifies; any script output prevents retry. Lease inspection, readiness reads, heartbeat, and release use the same bounded retry policy; allocation remains owned by Gateway provisioning replay. Exhausted retries preserve the coordinator diagnostic and report the number of attempts.

`settings.setup` runs on the leased box after Crabbox reports it ready and before ephemeral node enrollment. It runs on **every** provision attempt, including replay after an interrupted dispatch, so it must be safe to repeat. Workers forked from a [warm image](/gateway/cloud-workers/warm-images) skip it: the image key covers the exact setup script, so the image already carries its results. Setup that only starts processes, rather than writing to disk, does not survive into the fork. Fresh cloud images often still run cloud-init or unattended-upgrades when setup starts; a script that installs packages should wait for them (`cloud-init status --wait`) and pass an apt lock timeout (`-o DPkg::Lock::Timeout=600`), otherwise the first dispatch fails on a held `/var/lib/apt/lists/lock` while a retry on the same box would succeed. Check Node's version, not just executable presence, and preserve supported installations as in the example. Recheck the installed version and npm after any repair. If the final check still fails, fix the image's PATH or package selection before dispatching again. Automatic bootstrap installs the Gateway-matched OpenClaw runtime, not Node.js; keep the image or setup prerequisites aligned with the serving Gateway's `package.json` `engines.node` requirement when upgrading. If setup or enrollment fails, the provider stops the lease and the dispatch stops with an error; no half-configured paid box is hidden behind terminal state.

The example profile supports both OpenClaw and Codex. Keep setup focused on machine prerequisites and project tools. You do not need to install OpenClaw globally, append a versioned Codex plugin install, or maintain a package URL in the profile. Remove those old runtime-install steps when updating an existing profile; bootstrap supplies the running Gateway's runtime automatically.

When an agent tool waits for a bounded in-process Gateway request, stalled-run recovery honors the active response deadline, including nested Crabbox creation calls. Completing, failing, canceling, or timing out the wait removes its allowance; a prior run's pending request cannot extend the current run's budget. A response timeout does not by itself cancel provisioning. Inspect the environment's state before retrying an uncertain creation request.

### Native Windows prerequisites

For `windows/normal`, Crabbox executes `settings.setup` with Windows PowerShell. Write setup commands for PowerShell; Linux, macOS, and Windows (WSL2) continue to use POSIX scripts. For example, this prerequisite check uses the machine's existing Node and npm installation:

```powershell
$ErrorActionPreference = 'Stop'
& (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source --version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source --version
exit $LASTEXITCODE
```

Use a Crabbox bootstrap or image that supplies a supported Node.js release and npm on the machine `PATH`, with npm's CLI installed beside `node.exe` under `node_modules/npm`. OpenClaw fails enrollment with a prerequisite message if Node or that npm installation is missing; it does not install Node. npm installs the node runtime archive, and OpenClaw extracts worker bundles with its Node archive library.

Headless Windows guests must include Crabbox's managed launcher at `C:\Program Files\Crabbox\bin\Start-CrabboxDetachedProcess.ps1`. It keeps the node alive after Crabbox closes its SSH command. Enrollment fails with guidance if the launcher is absent. A hidden PowerShell parent redirects node output to `node.log` under its isolated state directory because the launcher does not inherit SSH output handles.

Restart replay verifies the actual `node.exe` child's PID, creation time, executable, and command line. Windows does not expose a cheap working-directory check, so the launch record binds the runtime and state directories to that verified creation time. Missing or mismatched identity rejects replay and requires reprovisioning. Desktop-enabled Windows workers instead use Crabbox's interactive desktop service and also bind the account SID and interactive session; see [native desktop prerequisites](/gateway/cloud-workers/desktop#native-windows-prerequisites).

## Bundle installation

Before enrolling a cloud node, the Gateway prepares a reusable runtime archive from its current built installation in a temporary staging directory. This works for published packages and source checkouts. It includes the complete node host and the trusted plugins that own the registered remote-execution commands required by the selected execution mode. Codex's plugin and its native dependency pin therefore travel with the node distribution without a separate profile recipe.

The archive is selected and verified by SHA-256 content digest, not by the OpenClaw version string or Git commit alone. Two source builds with the same version can produce different archives, including a build containing uncommitted changes. Build source changes with `pnpm build` and restart the Gateway before dispatching. Bootstrap does not compile an unbuilt checkout, copy raw edits over a running build, or rewrite the running Gateway's installation. Missing or mismatched build metadata produces an actionable rebuild-and-restart error.

Source builds may also contain private QA tooling. Bootstrap omits complete chunks only when their bytes match build-generated ownership metadata and all owners are private QA plugins. Chunks shared with public plugins or referenced by the retained runtime stay in the archive. Missing ownership metadata cannot authorize omission, and stale ownership or an incomplete import closure fails preparation without changing the running Gateway.

Crabbox uses the core bootstrap operation window for each runtime-preparation or enrollment command. Core sizes transfer time from the total archive bytes at its 125 KB/s throughput floor, capped at 60 minutes, and includes installation and operation headroom. The current operation window ranges from 45 to 95 minutes; Crabbox retains its 15-minute minimum for grants without a larger window. The provision deadline reserves the maximum window before allocating, plus the separate ten-minute node connection wait, for both runtime preparation and authenticated enrollment. Project capture adds its separate allowance. Profile setup, desktop work, diagnostics, cancellation, and cleanup retain their own allowances. Runtime preparation gives both download grants the same combined window. HTTP downloads retry after two minutes of socket inactivity and resume from retained partial bytes. Transfers that keep receiving bytes have no per-attempt time limit; all attempts still share the enclosing command deadline. Command deadlines never renew expired download authority or bypass live-owner checks. Initial pairing credentials remain valid for the live enrollment, including its size-derived bootstrap window and node connection wait. Closing or timing out an uncompleted enrollment revokes its pairing credential; replay issues a fresh credential for the same setup identity. After a Gateway restart, a live replacement enrollment may adopt a surviving pending credential, which cannot enroll a first device without that live binding.

Each enrollment receives short-lived download authority scoped to that live provisioning operation. Crabbox first receives a runtime-only artifact grant, with or without project image preparation: it installs the verified runtime without minting a node identity or enrollment credential. That grant closes before enrollment starts, and closing the provisioning operation revokes it. The node verifies the archive's declared size and digest, installs it as the node user, and enables its required plugins in isolated per-lease state only during enrollment. The archive contains runtime code and package metadata, not the Gateway's config, auth profiles, session state, or process environment. Download and enrollment credentials are not passed to npm or the launched node process.

Native dependencies are installed by npm for the cloud machine's operating system and CPU; the archive does not copy the build host's native `node_modules`. Registry access is still required, and this is not an offline dependency bundle. Bootstrap does not select a global OpenClaw installation merely because its version matches.

Bootstrap emits `CRABBOX_PHASE:openclaw-bootstrap-*` markers into the Crabbox command stream for download, installation, verification, plugin activation, and node launch. Crabbox records these as command phase timings; cached runs emit only the work they perform.

Enrollment enables its required plugins in one CLI invocation, in order, before publishing the runtime pointer or launching the node. Each plugin retains its normal policy and capability-consent checks; a failed enable stops enrollment. This avoids repeated CLI startup when a cloud desktop needs both an execution plugin and the computer-use plugin.

If enrollment was interrupted after publishing its runtime pointer but before recording the node PID, replay requires releasing and reprovisioning that worker. A detached process may still be running, so a missing PID does not authorize another launch. A retained launch receipt without a PID has the same recovery requirement.

During ordinary cloud provisioning and project image preparation, the runtime and worker archives download concurrently using their separate short-lived tokens. Once the runtime archive passes size and digest verification, npm installation and runtime verification proceed while the worker archive continues downloading. The `installation-and-worker-download` phase marks this overlap; worker download failures retain their own transport phase. A terminal failure cancels outstanding downloads or retry backoff, terminates the task-owned npm process tree, and preserves the first error. Both branches, including any already-started npm process, must settle before temporary files are removed. Worker archive publication and runtime publication wait for the join.

The Gateway reuses its prepared archive for subsequent enrollments with the same execution mode. Nodes keep successful installs under `~/.openclaw-worker/node-runtimes/<sha256>`, so a warm image can reuse the exact artifact. A different digest selects a different installation even when the version is unchanged. The runtime archive omits worker deploy artifacts and the Gateway's Control UI assets, reducing transfer and installation work. The Gateway continues to serve the dashboard. Core prepares the worker bundle before provisioning, alongside the runtime archive, so both immutable artifacts are available for runtime preparation. After enrollment, OpenClaw `worker-turn` installs the content-addressed worker bundle from the matching archive downloaded during runtime preparation or retained in a prepared project image, or downloads it through the authenticated node channel when that archive is absent. A successful local archive verification emits `Worker bundle already prepared locally: <sha256>` in the node log and skips the worker-bundle HTTP GET. Prepared archives still undergo validation; see [Warm images](/gateway/cloud-workers/warm-images). Codex `remote-exec` starts the managed exec-server directly. Existing placement checks, node-command allowlists, and invocation approval still govern execution.

Worker bundle downloads on the node resume from retained staging bytes after transient transfer failures. Retries use jittered backoff and stop after three consecutive failures without retained progress. Each grant permits at most 256 serial serves within its existing lifetime and live-owner checks. The node verifies the complete archive's size and SHA-256 digest before installation and removes staging on terminal failure or cancellation; partial downloads do not survive a failed install.

While a prepared worker is provisioning, cache cleanup retains the exact worker bundle recorded at admission, including before readiness produces a bootstrap receipt. After the environment reaches a terminal state, normal bundle cleanup can reclaim those bytes when no other environment or placement needs them.

Worker bundles include their JavaScript dependencies, including the WebSocket transport. They target Node.js even when Bun runs the build; the destination still needs a supported Node.js installation.

### Reuse a node runtime archive after Gateway restart

Linux and macOS deployment images can retain an already prepared node runtime archive as `node-runtime.tgz` in the running OpenClaw package root, beside `package.json`. During image preparation, copy the producer's archive there before closing the producer:

```bash
cp /path/to/prepared/node-runtime.tgz /path/to/openclaw/node-runtime.tgz
```

The first cloud-node preparation in a new Gateway process copies that optional input into private temporary storage and verifies its actual files, contents, sizes, and permissions against the running distribution and selected plugins. It still checks build identity, exact dependency pins, and the built import closure. A version string or neighboring checksum manifest does not authorize reuse. Matching archives skip compression; missing, corrupt, unsafe, or mismatched inputs use the existing builder. Different execution modes can select different plugins and therefore rebuild from the same image input.

Distribution scanning, import validation, archive construction, and hashing run in a worker thread so preparation does not block the Gateway's event loop. Enrollment and prepared-pool maintenance await the same verified artifact; canceling one enrollment does not cancel preparation for other consumers.

The deployment image owns the retained file. Gateway shutdown removes only its temporary copy, after active consumers finish. Replace the image archive when the distribution or plugins change; removing it restores ordinary preparation. Windows Gateways continue to build their archive because the shared Windows archive reader normalizes permissions rather than preserving the tar modes needed for this comparison.

This avoids repeated archive construction after restart. It does not reuse enrollment credentials, skip worker authorization, or eliminate worker installation and startup. Measure archive validation separately from end-to-end worker readiness when evaluating cold-start savings.

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
