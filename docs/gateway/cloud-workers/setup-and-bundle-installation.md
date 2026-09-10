---
summary: "The idempotent setup command, Gateway-prepared runtime archives, and building a custom node package"
title: "Worker setup and bundle installation"
read_when: "You are writing a profile setup command, or you need a custom node distribution."
---

What runs on the leased box before enrollment, how the Gateway prepares and verifies the runtime archive it installs there, and how to build a complete custom node package.

## The setup command

`settings.setup` runs on the leased box after Crabbox reports it ready and before ephemeral node enrollment. It runs on **every** provision attempt, including replay after an interrupted dispatch, so it must be idempotent. Check Node's version, not just executable presence, and preserve supported installations as in the example. Recheck the installed version and npm after any repair. If the final check still fails, fix the image's PATH or package selection before dispatching again. Automatic bootstrap installs the Gateway-matched OpenClaw runtime, not Node.js; keep the image or setup prerequisites aligned with the serving Gateway's `package.json` `engines.node` requirement when upgrading. If setup or enrollment fails, the provider stops the lease and the dispatch fails closed; no half-configured paid box is hidden behind terminal state.

The example profile supports both OpenClaw and Codex. Keep setup focused on machine prerequisites and project tools. You do not need to install OpenClaw globally, append a versioned Codex plugin install, or maintain a package URL in the profile. Remove those old runtime-install steps when updating an existing profile; bootstrap supplies the running Gateway's runtime automatically.

## Bundle installation

Before enrolling a cloud node, the Gateway prepares a reusable runtime archive from its current built installation in a temporary staging directory. This works for published packages and source checkouts. It includes the complete node host and the trusted plugins that own the registered remote-execution commands required by the selected execution mode. Codex's plugin and its native dependency pin therefore travel with the node distribution without a separate profile recipe.

The archive is selected and verified by SHA-256 content digest, not by the OpenClaw version string or Git commit alone. Two source builds with the same version can produce different archives, including a build containing uncommitted changes. Build source changes with `pnpm build` and restart the Gateway before dispatching. Bootstrap does not compile an unbuilt checkout, copy raw edits over a running build, or rewrite the running Gateway's installation. Missing or mismatched build metadata produces an actionable rebuild-and-restart error.

Each enrollment receives short-lived download authority scoped to that live provisioning operation. Project image preparation first receives a runtime-only artifact grant: it installs the verified runtime without minting a node identity or enrollment credential. That grant closes before enrollment starts, and closing the provisioning operation revokes it. The node verifies the archive's declared size and digest, installs it as the node user, and enables its required plugins in isolated per-lease state only during enrollment. The archive contains runtime code and package metadata, not the Gateway's config, auth profiles, session state, or process environment. Download and enrollment credentials are not passed to npm or the launched node process.

Native dependencies are installed by npm for the cloud machine's operating system and CPU; the archive does not copy the build host's native `node_modules`. Registry access is still required, and this is not an offline dependency bundle. Bootstrap does not select a global OpenClaw installation merely because its version matches.

Bootstrap emits `CRABBOX_PHASE:openclaw-bootstrap-*` markers into the Crabbox command stream for download, installation, verification, plugin activation, and node launch. Crabbox records these as command phase timings; cached runs emit only the work they perform.

The Gateway reuses its prepared archive for subsequent enrollments with the same execution mode. Nodes keep successful installs under `~/.openclaw-worker/node-runtimes/<sha256>`, so a warm image can reuse the exact artifact. A different digest selects a different installation even when the version is unchanged. The runtime archive omits worker deploy artifacts and the Gateway's Control UI assets, reducing transfer and installation work. The Gateway continues to serve the dashboard. After enrollment, OpenClaw `worker-turn` installs the content-addressed worker bundle from a matching archive retained in a prepared project image, or downloads it through the authenticated node channel when that archive is absent. Prepared archives still undergo validation; see [Warm images](/gateway/cloud-workers/warm-images). Codex `remote-exec` starts the managed exec-server directly. Existing placement checks, node-command allowlists, and invocation approval still govern execution.

## Build a complete custom node package

Automatic cloud bootstrap does not require a manually published package. For a separate deployment or package-validation workflow, the canonical package builder can still produce a complete custom distribution and explicitly include source-owned plugins that the ordinary core package excludes:

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

Run this in a clean, trusted checkout with dependencies installed. The builder compiles the runtime, includes the selected plugin's built entrypoints and import closure, and regenerates the installation inventory. It temporarily adds the plugin's exact runtime dependency pins to the distribution manifest, rejecting conflicting or unpinned dependencies, then restores the source manifest and inventory. Repeat `--bundle-plugin <id>` for additional source plugins. Without that option, the ordinary core package and external plugin publication contracts are unchanged.

Deliver the resulting archive through your existing immutable artifact path and verify its SHA-256 before installing it with normal npm lifecycle scripts enabled. Record both source SHA and archive digest: different unreleased builds can share a version. Do not copy a plugin into an installed release or substitute a standalone `npm-pack:` plugin archive for this distribution. Cloud profiles do not consume this URL; their enrollment artifact comes from the running Gateway.

After verifying the downloaded archive, install it with the mask scoped to the root command, then verify the version as the user who will run it:

```bash
sudo sh -c 'umask 022 && npm install -g /tmp/openclaw-cloud.tgz'
openclaw --version
```

Use the path of your verified archive in place of `/tmp/openclaw-cloud.tgz`. Changing the install mask does not repair existing root-only parent directories; if an earlier install was inaccessible, correct access to that package and its parent directories before retrying enrollment.

Native dependencies are declared at the distribution root and installed for the target operating system and CPU; the archive does not copy the build host's plugin `node_modules`. Target installation still needs registry access and is not an offline dependency bundle. Verify each target architecture you deploy. Use `--skip-build` only when reusing a complete build from that same source revision with all selected plugin outputs present.
