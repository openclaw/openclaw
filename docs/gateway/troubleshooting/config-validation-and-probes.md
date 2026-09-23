---
summary: "Recovering from a rejected config and reading gateway probe warnings"
title: "Config validation and probes"
sidebarTitle: "Config validation and probes"
read_when:
  - The Gateway rejected an invalid config and you need the recovery path
  - You need to know what the `.rejected`, `.bak`, and last-known-good copies hold
  - Gateway probe warnings appear in status or doctor output
---

## Gateway rejected invalid config

Use when Gateway startup fails with `Invalid config` or hot reload logs say it skipped an invalid edit.

Startup automatically migrates deterministic legacy keys in eligible single-file
configs and continues only if the entire result validates, including plugins. It
keeps the previous config in the `.bak` ring. Configs using `$include`, Nix-managed
configs, configs written by a newer version, and configs that still fail validation
require operator repair. See [Legacy config key migrations](/gateway/doctor#detailed-behavior-and-rationale).

```bash
openclaw logs --follow
openclaw config file
openclaw config validate
openclaw doctor
```

Look for:

- `Invalid config at ...`
- `config reload skipped (invalid config): ...`
- `Config write rejected: ...`
- A timestamped `openclaw.json.rejected.*` file beside the active config.
- A timestamped `openclaw.json.clobbered.*` file if `doctor --fix` repaired a broken direct edit.
- OpenClaw keeps the latest 32 `.clobbered.*` files for each config path and rotates older ones.

<AccordionGroup>
  <Accordion title="What happened">
    - The config did not validate during startup, hot reload, or an OpenClaw-owned write.
    - Gateway startup leaves `openclaw.json` unchanged and fails closed when safe legacy-key migration cannot produce a fully valid config.
    - Hot reload skips invalid external edits and keeps the current runtime config active.
    - OpenClaw-owned writes reject invalid/destructive payloads before commit and save `.rejected.*`.
    - `openclaw doctor --fix` owns repairs beyond automatic legacy-key migration. It can remove non-JSON prefixes or restore the last-known-good copy; a recovery attempts to preserve the replaced payload as `.clobbered.*` (best effort, the snapshot can be skipped under disk or rotation limits).
    - When many repairs happen for one config path, OpenClaw rotates older `.clobbered.*` files so the newest repaired payload is still available.

  </Accordion>
  <Accordion title="Inspect and repair">
    ```bash
    CONFIG="$(openclaw config file)"
    ls -lt "$CONFIG".clobbered.* "$CONFIG".rejected.* 2>/dev/null | head
    diff -u "$CONFIG" "$(ls -t "$CONFIG".clobbered.* 2>/dev/null | head -n 1)"
    openclaw config validate
    openclaw doctor
    ```
  </Accordion>
  <Accordion title="Common signatures">
    - `.clobbered.*` exists → doctor preserved a broken external edit while repairing the active config.
    - `.rejected.*` exists → an OpenClaw-owned config write failed schema or clobber checks before commit.
    - `Config write rejected:` → the write tried to drop required shape, shrink the file sharply, or persist invalid config.
    - `config reload skipped (invalid config):` → a direct edit failed validation and was ignored by the running Gateway.
    - `Invalid config at ...` → startup failed before Gateway services booted.
    - `gateway-mode-missing-vs-last-good`, `update-channel-only-root`, or `size-drop-vs-last-good:*` → the active config lost `gateway.mode`, was reduced to a bare `update.channel` root, or shrank to under half of the last-known-good size; the next config read restores last-known-good and attempts to preserve the current payload as `.clobbered.*` (best effort). When the accepted baseline is itself a hand-authored config (no `meta`), a `.bak` holding different bytes predates that file, so restoring it would revert the operator's config. If a promoted `.last-good` copy still matches the accepted baseline byte for byte, it is restored instead (logged as `Config auto-restored from last-good:`), even when the `.bak` copy is missing, unreadable, or rejected; otherwise the restore is skipped with a `Config auto-restore from backup skipped:` warning that no verified last-good copy exists. The active file still validates, so `openclaw doctor --fix` does not auto-restore it either; compare the file with the `.bak` copy (or your own backup), restore the lost keys by hand with `openclaw config set` or an edit, then run `openclaw config validate`.
    - `missing-meta-vs-last-good` → a valid config lost its `meta` block. On its own nothing is restored: the file is left in place and OpenClaw warns `Config observe anomaly: <path> (missing-meta-vs-last-good)`, since OpenClaw-owned writes always stamp `meta` and a valid file without it was authored outside OpenClaw. The accepted read also advances the recorded last-known-good baseline to those bytes, so a later recognized clobber is compared against the operator's file instead of the previous product-written generation. When it appears alongside one of the recoverable signals above, that signal still drives last-known-good restoration — unless the accepted baseline is hand-authored and the backup holds different bytes, where the skip described in the previous bullet applies.
    - `Config last-known-good promotion skipped` → the candidate contained redacted secret placeholders such as `***`.

  </Accordion>
  <Accordion title="Fix options">
    An interactive startup can offer to run `openclaw doctor --fix` and retry once when automatic legacy-key migration is not enough. Non-interactive startup prints the repair command instead.

    1. Run `openclaw doctor --fix` to let doctor repair prefixed/clobbered config or restore last-known-good.
    2. Copy only the intended keys from `.clobbered.*` or `.rejected.*`, then apply them with `openclaw config set` or `config.patch`.
    3. Run `openclaw config validate` before restarting.
    4. If you edit by hand, keep the full JSON5 config, not just the partial object you wanted to change.

  </Accordion>
</AccordionGroup>

Related:

- [Config](/cli/config)
- [Configuration: hot reload](/gateway/configuration#config-hot-reload)
- [Configuration: strict validation](/gateway/configuration#strict-validation)
- [Doctor](/gateway/doctor)

## Gateway probe warnings

Use when `openclaw gateway probe` reaches something, but still prints a warning block.

```bash
openclaw gateway probe
openclaw gateway probe --json
openclaw gateway probe --ssh user@gateway-host
```

Look for:

- `warnings[].code` and `primaryTargetId` in JSON output.
- Whether the warning is about SSH fallback, multiple gateways, missing scopes, or unresolved auth refs.

Common signatures:

- `SSH tunnel failed to start; falling back to direct probes.` → SSH setup failed, but the command still tried direct configured/loopback targets.
- `multiple reachable gateway identities detected` → distinct gateways answered, or OpenClaw could not prove reachable targets are the same gateway. An SSH tunnel, proxy URL, or configured remote URL to the same gateway is treated as one gateway with multiple transports, even when transport ports differ.
- `Read-probe diagnostics are limited by gateway scopes (missing operator.read)` → connect worked, but detail RPC is scope-limited; pair device identity or use credentials with `operator.read`.
- `Gateway accepted the WebSocket connection, but follow-up read diagnostics failed` → connect worked, but the full diagnostic RPC set timed out or failed. Treat this as a reachable Gateway with degraded diagnostics; compare `connect.ok` and `connect.rpcOk` in `--json` output.
- `Capability: pairing-pending` or `gateway closed (1008): pairing required` → the gateway answered, but this client still needs pairing/approval before normal operator access.
- Unresolved `gateway.auth.*` / `gateway.remote.*` SecretRef warning text → auth material was unavailable in this command path for the failed target.

Related:

- [Gateway](/cli/gateway)
- [Multiple gateways on the same host](/gateway#multiple-gateways-same-host)
- [Remote access](/gateway/remote)
