# Phala CLI Suggestions

Collected ideas for improving the Phala Cloud CLI. File issues or PRs upstream as appropriate.

## 2026-02-01

### Support `build:` in compose (or give a clear error)

Phala silently accepts compose files with `build:` but the container never starts. Either build remotely or reject upfront with: "Phala Cloud requires pre-built images. Push your image to a registry and use `image:` instead."

### Allow `--name` for updates

~~`phala deploy -n openclaw-dev` should update an existing CVM with that name instead of erroring. Currently you must use `--cvm-id <uuid>`. The UUID is hard to remember.~~

**2026-02-15 update:** Fixed — `--cvm-id` now accepts names, app_ids, and UUIDs (v1.1.8). However, see the `--wait` poller bug below.

### Surface container crash logs

When a container exits immediately, `phala logs <name>` says "No containers found." It should still return logs from the exited container (like `docker logs` does).

### Add `phala exec`

Like `docker exec` — run a command inside a running container without setting up SSH tunnels.

### Improve error messages

The "Required" validation error for `phala logs` should say "Container name is required as a positional argument" instead of just `Invalid value for "containerName": Required`.

## 2026-02-02

### Show public URLs in `phala cvms get`

`phala cvms get` doesn't show port mappings or the gateway hostname. Users have to manually construct URLs like `<app_id>-<port>.<gateway>.phala.network`. The command should display the public URL for each exposed port.

### Fix `phala cvms get --json`

JSON output returns empty strings for key fields (e.g. `hosted_on`, `dstack_node_info.endpoint`). The non-JSON table output also truncates the app URL.

### Clarify `phala cvms logs` vs `phala logs`

`phala cvms logs` returns VM serial logs (includes noisy dockerd/containerd output). `phala logs` returns clean container logs. The distinction isn't documented or obvious. Consider making `phala logs` the default and adding `phala logs --serial` for VM-level logs, or at least document the difference.

### Show image pull progress after `phala deploy --cvm-id`

~~After updating a compose digest, `phala deploy --cvm-id` returns immediately but the new container doesn't start for minutes while the image pulls. There's no way to track progress. A `--wait` flag (like initial deploy) or a progress indicator would help.~~

**2026-02-15 update:** `--wait` now exists and works when `--cvm-id` is a `vm_uuid`. Broken for names and app_ids — see below.

### Add `phala cvms restart`

No way to restart a container without redeploying the same compose file. A simple `phala cvms restart <name>` would be useful.

### Allow multiple names in `phala cvms delete`

`phala cvms delete cvm1 cvm2 cvm3 -y` would be more convenient than running the command once per CVM.

## 2026-02-15

### `phala deploy --wait` readiness poller only works with `vm_uuid`

`--cvm-id` accepts names, app_ids, and UUIDs for the deploy step, but the `--wait` readiness poller only works when the raw `--cvm-id` value is a hyphenated `vm_uuid`. Names and hex app_ids both fail with "Invalid UUID format" in a 300 s loop.

Repro (v1.1.8):

```bash
# These deploy fine but --wait loops with "Invalid UUID format":
phala deploy --cvm-id openclaw-dev -c compose.yml -e deploy.env --wait
phala deploy --cvm-id 43069de20638d656a2d0e49fb074bee1049bc90e -c compose.yml -e deploy.env --wait

# This works end-to-end:
phala deploy --cvm-id 0cd515c5-ef55-4f8a-8adf-9bc71318ff8e -c compose.yml -e deploy.env --wait
# ✓ CVM is ready (took 58s)
```

Fix: the deploy command resolves `--cvm-id` to an internal ID for the update API call — the poller should reuse that resolved ID instead of passing the raw CLI argument to a UUID-validated code path.
