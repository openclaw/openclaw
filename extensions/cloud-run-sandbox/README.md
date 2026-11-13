# Cloud Run sandbox — draft

An opt-in prototype for the **tool-execution half** of [RFC 76](https://github.com/openclaw/rfcs/pull/76). It runs shell/file operations in named Google Cloud Run preview guests using the existing public sandbox SDK. It does not provision cloud resources or provide durable Gateway hosting.

## Execution and cleanup

Each command gets a fresh guest with an explicit clean root and selected workspace mounts. Creation starts only an idle process; current runtime authority is checked before admitting command/file work. Explicit environment values are staged over stdin, not placed in launcher arguments.

Cancellation, interrupt and finalization delete the **guest**, not just the launcher. A non-evicting SQLite journal records each guest before allocation; failed cleanup retains its receipt and does not skip independent guests. Guest-root changes and background processes do not persist between commands. The idle process has a finite lifetime, defaulting to 600 seconds.

## Required environment

- An isolated Cloud Run workload with Google sandbox support enabled. Current mount/egress functionality requires Linux/root in a dedicated experimental environment. **The standard OpenClaw image keeps `USER node`.**
- A separately prepared, root-owned guest filesystem containing POSIX shell, sleep, env, Python 3, filesystem tools, loader and libraries. Never use `/`, Gateway state, credentials, or a copy of the live host filesystem. Read-only is not secret.
- Disjoint host sources whenever either mount is writable. **Ordinary nested skill/instruction folders inside writable workspaces currently fail closed.** Disjoint read-only resources work; nested sources need a provider-supported pinned mount mechanism.

## Configuration

This private plugin is not published to npm or ClawHub. Use a source/linked development install in a test Gateway:

```json5
{
  plugins: {
    entries: {
      "cloud-run-sandbox": {
        enabled: true,
        config: {
          rootfs: "/opt/openclaw-sandbox-rootfs",
          allowEgress: false,
          guestLifetimeSeconds: 600,
        },
      },
    },
  },
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "cloud-run-sandbox",
        workspaceAccess: "none",
      },
    },
  },
}
```

`none` exposes the selected private workspace; `ro` makes selected mounts read-only; `rw` permits selected workspace writes. A distinct authorized agent workspace maps to `/agent`. Egress defaults off; enabling it grants broad outbound access, not a domain allowlist. Review metadata/private-network exposure first. Lifetime accepts 30–3600 seconds.

## Verification

Unit regressions: `pnpm test extensions/cloud-run-sandbox`.

Build the opt-in live probe with:

```sh
pnpm exec tsdown --config extensions/cloud-run-sandbox/test/live-proof.config.mjs
```

Copy `.artifacts/cloud-run-live/live-proof.mjs` into an isolated Cloud Run container where the installed OpenClaw SDK resolves. Run `node live-proof.mjs <absolute-clean-rootfs> <absolute-fresh-state-dir>`. The probe refuses a nonempty state directory. Use synthetic data, a no-role service account, one task, zero retries, a bounded task timeout and verified cloud-resource deletion. Billing budgets are alerts, not hard caps.

The probe runs the current plugin against the real launcher and SQLite store. It controls the supplied authority callback to revoke execution after native creation/staging and before final command/file I/O. Separate child processes test acknowledged-orphan cleanup and the interrupted-create receipt. This is **plugin-boundary proof**, not a model-driven turn, core authority-lifecycle certification, or a production security review. It does not provision resources automatically.

## Remaining boundaries

- Ambiguous creation remains fail-closed: absence after one delete cannot rule out a late create. The receipt stays until the enclosing container is stopped and ownership reconciled; automatic recovery needs a stronger provider settlement contract.
- Runtime listing reports an error while Cloud Run has recorded guests: the launcher has no read-only inspect operation, and guest-controlled executables are not safe health probes. Removal/pruning remain available through their separate cleanup path.
- Guest PTYs, sandboxed browsers, arbitrary Docker binds, setupCommand and managed-project projections are unsupported. There is no fallback to host execution.
- **GCS FUSE is not supported for live OpenClaw state.** The real Gateway failed config/file-identity checks and logged SQLite-related write-order errors in the hosting experiment. A small file/SQLite smoke did not prove application compatibility. Ingress, durable hosting and upgrades are separate work.
- Keep this draft unpromoted until independent security-owner review, remaining hostile/concurrent-path validation and the repository configuration-budget decision are complete.

References: [Google code execution](https://docs.cloud.google.com/run/docs/code-execution), [sandbox CLI](https://docs.cloud.google.com/run/docs/reference/sandbox-cli), [GCS FUSE limitations](https://docs.cloud.google.com/storage/docs/cloud-storage-fuse/overview#limitations).
