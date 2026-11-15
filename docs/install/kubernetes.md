---
summary: "Deploy OpenClaw Gateway to a Kubernetes cluster with Kustomize"
read_when:
  - You want to run OpenClaw on a Kubernetes cluster
  - You want to test OpenClaw in a Kubernetes environment
title: "Kubernetes"
---

A minimal starting point for running OpenClaw on Kubernetes, not a production-ready deployment. It covers the core resources and is meant to be adapted to your environment.

## Why not Helm

OpenClaw is a single container with some config files. The interesting customization is in agent content (Markdown files, skills, config overrides), not infrastructure templating. Kustomize handles overlays without the overhead of a Helm chart. Layer a Helm chart on top of these manifests if your deployment grows more complex.

## What you need

- A running Kubernetes cluster (AKS, EKS, GKE, k3s, kind, OpenShift, etc.)
- `kubectl` connected to your cluster
- An API key for at least one model provider

## Quick start

```bash
# Export the key for the provider you configured. Use ANTHROPIC_API_KEY,
# GEMINI_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.
export ANTHROPIC_API_KEY="..."
./scripts/k8s/deploy.sh

kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://127.0.0.1:18789
```

`deploy.sh` creates token auth by default. Retrieve the generated gateway token for the Control UI:

```bash
kubectl get secret openclaw-secrets -n openclaw -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d
```

For local debugging, `./scripts/k8s/deploy.sh --show-token` prints the token after deploy.

## Local testing with Kind

If you do not have a cluster, create one locally with [Kind](https://kind.sigs.k8s.io/):

```bash
./scripts/k8s/create-kind.sh           # auto-detects docker or podman
./scripts/k8s/create-kind.sh --delete  # tear down
```

Then deploy as usual with `./scripts/k8s/deploy.sh`.

## Step by step

### 1) Deploy

**Option A: API key in environment (one step)**

```bash
# Export the key for the provider you configured. Use ANTHROPIC_API_KEY,
# GEMINI_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.
export ANTHROPIC_API_KEY="..."
./scripts/k8s/deploy.sh
```

The script creates a Kubernetes Secret with the API key and an auto-generated gateway token, then deploys. If the Secret already exists, it preserves the current gateway token and any provider keys not being changed.

**Option B: create the secret separately**

```bash
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

Add `--show-token` to either command to print the token to stdout for local testing.

### 2) Access the gateway

```bash
kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://127.0.0.1:18789
```

## What gets deployed

```text
Namespace: openclaw (configurable via OPENCLAW_NAMESPACE)
├── Deployment/openclaw        # Single pod, init container + gateway
├── Service/openclaw           # ClusterIP on port 18789
├── PersistentVolumeClaim      # 10Gi for agent state and config
├── ConfigMap/openclaw-config  # openclaw.json + AGENTS.md
└── Secret/openclaw-secrets    # Gateway token + API keys
```

Keep `replicas: 1` and the provided `Recreate` strategy so replacements stop the
old pod before starting another Gateway against the same state. The PVC must
use persistent local or block storage with a local filesystem, not an NFS, SMB,
or CIFS share. `ReadWriteOnce` alone guarantees neither that storage choice nor
one pod at a time. See [SQLite storage requirements](/install/docker/networking-and-storage#storage-and-persistence).

The Deployment checks `/readyz` for startup and traffic readiness with a five-minute startup budget, and `/healthz` for liveness. Every check asserts the JSON check contract rather than the status code alone, because the Control UI answers unknown paths with a catch-all `200`; a status-only check would pass forever against an image whose check route does not exist yet.

`/startupz` is the better traffic-admission check because it ignores channel health, so one failing channel account cannot evict an otherwise healthy Gateway from Service endpoints. It requires an image built from `2026.8.1` or newer, the release that introduced it, which is newer than the tag pinned above. After pinning such an image, switch the startup and readiness checks to `/startupz` and keep `/readyz` for monitoring that should include channel-account health.

## Customization

### Agent instructions

Edit the `AGENTS.md` in `scripts/k8s/manifests/configmap.yaml` and redeploy:

```bash
./scripts/k8s/deploy.sh
```

### Gateway config

Edit `openclaw.json` in `scripts/k8s/manifests/configmap.yaml`. See [Gateway configuration](/gateway/configuration) for the full reference.

The init container seeds `openclaw.json` and workspace `AGENTS.md` only when each file is missing from the PVC. The persisted copy is the source of truth after first boot: changes made through OpenClaw (`onboard`, `channels add`, `doctor --fix`, Control UI) survive pod restarts, and updating the ConfigMap does not overwrite an existing PVC copy. To intentionally reseed a file from an updated ConfigMap, delete the persisted copy and restart:

```bash
kubectl exec -n openclaw deploy/openclaw -- rm /home/node/.openclaw/openclaw.json
kubectl rollout restart -n openclaw deploy/openclaw
```

Keep `openclaw.json.last-good` and the `openclaw.json.bak*` backups when reseeding.
A valid replacement does not need a `meta` block: `openclaw doctor --fix` keeps
it, and the Gateway promotes it to last-good after it starts successfully.
Truncated or invalid configs still use backup recovery. If recovery replaces a
file, the warning names the saved `openclaw.json.clobbered.*` original and explains
how to copy it back after correcting the reported problem.

Deployments created from the previous template applied ConfigMap edits on every pod start (and discarded any config changes made through OpenClaw). If you relied on that flow, use the reseed commands above after ConfigMap edits.

### Temporary storage

The init container prepares a sticky-protected `gateway-tmp` directory (mode `1777`) on the `emptyDir` volume and mounts it at `/tmp` with `subPath`. Keep this layout when customizing the temp volume: filesystem safety checks reject group- or world-writable ancestors without sticky protection, even when `/tmp/openclaw` itself is private. Setting `fsGroup` alone does not add the sticky bit.

The volume must be writable by the init container, which must share the Gateway's effective UID to create and chmod the directory. The recipe uses UID/GID and `fsGroup` 1000. On platforms that assign arbitrary UIDs, adapt these security contexts together. Preparation failures stop initialization and appear in `kubectl logs -n openclaw deploy/openclaw -c init-config`.

### Private storage after a PVC remount

Kubernetes can widen existing volume permissions when applying `fsGroup` on
mount. The template requests `fsGroupChangePolicy: OnRootMismatch` so kubelet
can skip recursive permission changes when the volume root already matches.
This preserves private child modes only while that condition holds; it neither
repairs existing widened paths nor establishes that the contents are safe.
If the root stops matching, kubelet can walk the volume again. CSI drivers that
advertise `VOLUME_MOUNT_GROUP` handle permissions themselves, so this policy
does not apply to them. See [Kubernetes volume permission policy](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/#configure-volume-permission-and-ownership-change-policy-for-pods).

Gateway startup and admitted Doctor repair restore the private modes of the
stores this installation owns before credential admission and Doctor's recovery
capture, so a remount
that widens them no longer blocks startup. The restore covers the client
credential store, the daemon runtime pin store, their SQLite sidecars, and the
sibling `<stateDir>.update-captures` directory.
Ordinary state writes harden their own database and sidecars without repeating
this startup repair across the other private stores.

The state directory itself is left as it is found. A shared, group-accessible
state root is a supported layout — config publication preserves its mode while
keeping the files inside private — so only the private stores under and beside
it are restored.

The restore is deliberately narrow. It repairs an enumerated path list rather
than walking the state tree, changes no ownership, skips symlinks instead of
following them, leaves paths owned by another UID alone, and leaves any path
carrying world permission bits for its owner to refuse, because `fsGroup` never
sets those. Every downstream admission check stays as strict as before:
membership in the volume's group still does not grant private credential
authority.

Two cases still need the storage owner.

A kubelet-created mount point stays owned by another UID, and `fsGroup` leaves it
group-writable. Doctor's pre-repair recovery copy refuses a staging ancestor that
another user could replace, and it walks the whole ancestor chain, so it names the
mount point itself. Placing the state directory deeper under that mount does not
help. Restoring modes is not ownership transfer and an unprivileged container
cannot chown a foreign-owned mount point, so recovery capture needs a mount point
provisioned with the Gateway's ownership before startup, as described below. The
Gateway still starts and Doctor still completes; only the pre-repair recovery copy
is unavailable.

Sharing the same private state stores between workloads through group membership
is not supported: the stores must remain private to their Gateway UID. A
group-accessible PVC root can still contain separate UID-owned private subpaths
for different workloads; sharing the PVC does not grant access to those stores.

If startup still reports `Client credential directory is unsafe`, keep the
Gateway stopped and have the storage owner inspect the state directory, its
`client/credentials.sqlite` store, and the sibling `<stateDir>.update-captures`
directory. Credential directories and files must remain private to the Gateway
UID (`0700` and `0600`, respectively). Recovery storage also needs trusted
ancestors that prevent other users from replacing its directories.

The shipped PVC mount covers `/home/node/.openclaw`, while retained update
captures resolve to `/home/node/.openclaw.update-captures`. That sibling needs a
writable, persistent location when adapting this template for recovery capture.

For a new or explicitly migrated layout, the storage owner can provision separate
private child directories on the PVC and expose them through `subPath` mounts at
`/home/node/.openclaw` and `/home/node/.openclaw.update-captures`. This keeps the
PVC root out of the Gateway's path ancestry. Both children must be owned by the
Gateway UID, with trusted ancestors at their container mount points. Their source
entries on the volume also need protection from replacement before they are
mounted. `subPath` alone does not establish ownership or protect private modes
from volume-wide permission changes.

This is an operator-provisioned layout, not an automatic upgrade of the supplied
mount. Deployments using the supplied mount store state at the PVC root.
Switching them to an empty child would hide that state and can initialize a different installation.
Before such a cutover, the storage owner must stop all state users, retain a
verified backup, and preserve the complete state and matching recovery data in
the selected children. Include config, credentials, databases and their sidecars,
and retained migration/backup artifacts. Preserve the old data until the new
mounts and recovery have been verified. Do not infer that the existing `state/`
directory is a suitable child: it contains the shared database, not the complete
OpenClaw state tree.

If a customized deployment instead mounts its PVC at `/home/node` and already
has complete `.openclaw` and `.openclaw.update-captures` children, those existing
directories can be selected as the subpaths without relocating their data. The
storage owner must still verify ownership, private modes, source-entry protection,
and the target mount ancestry before changing the mounts. Do not automatically
create missing children or reseed config as a substitute for existing data.

The Gateway performs this restore for its own enumerated paths. A
deployment-specific preparation step is still what establishes ownership of a
foreign-owned mount root, and can restore modes on exact, authorized, UID-owned
private paths after mounting and before Gateway or Doctor admission.
It must refuse symlinks, hardlinked files, foreign owners, unsafe ancestors, and
unsupported recovery states, and leave source/schema/backup validation intact.
Pathname `chmod` after a separate check is not a validated implementation of
these requirements. The unprivileged init container cannot make a foreign-owned
mount root private. Avoid recursive `chmod` or `chown` over the state tree.
Verify both the initial boot and a subsequent PVC remount with the selected
storage driver before relying on restart recovery.

### Add providers

Re-run with additional keys exported:

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

Existing provider keys stay in the Secret unless you overwrite them.

Or patch the Secret directly:

```bash
kubectl patch secret openclaw-secrets -n openclaw \
  -p '{"stringData":{"<PROVIDER>_API_KEY":"..."}}'
kubectl rollout restart deployment/openclaw -n openclaw
```

### Custom namespace

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh
```

### Custom image

Edit the `image` field in `scripts/k8s/manifests/deployment.yaml`:

```yaml
# Bump this immutable versioned tag when upgrading OpenClaw.
image: ghcr.io/openclaw/openclaw:2026.7.1-2-slim
```

Images from `2026.8.1` onward need a [writable cache location](/install/kubernetes#architecture-notes); the shipped manifest provides it through `XDG_CACHE_HOME`. When upgrading an older deployment, apply that environment entry along with the image change.

The official image entrypoint runs Doctor before the Gateway, but this manifest's
explicit `command` bypasses it. Before upgrading an existing PVC, back up its
state, scale the Deployment to zero, wait for its pods to terminate, and run the
new image's `openclaw doctor --fix --non-interactive` in a one-off pod or Job with
the same state/config mounts. Restore one replica only after Doctor succeeds.
See [container upgrade and recovery](/install/docker#upgrading-container-images).

### Expose beyond port-forward

The default manifests bind the gateway to loopback inside the pod. That works with `kubectl port-forward`, but not with a Kubernetes `Service` or Ingress path that needs to reach the pod IP directly.

To expose the gateway through an Ingress or load balancer:

- Change the gateway bind in `scripts/k8s/manifests/configmap.yaml` from `loopback` to a non-loopback bind that matches your deployment model.
- Keep gateway auth enabled and use a proper TLS-terminated entrypoint.
- Configure the Control UI for remote access using the supported web security model (for example HTTPS/Tailscale Serve and explicit allowed origins when needed).

## Re-deploy

```bash
./scripts/k8s/deploy.sh
```

This applies all manifests and restarts the pod to pick up any config or secret changes.

## Teardown

```bash
./scripts/k8s/deploy.sh --delete
```

For the default `openclaw` namespace, this deletes the namespace and everything in it, including the PVC.

For a custom namespace, `--delete` removes only OpenClaw resources and preserves the namespace and unrelated workloads:

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh --delete
```

Use `--delete-resources` to request this scoped teardown explicitly in any namespace. Both scoped modes delete the OpenClaw Deployment, Service, PVC, ConfigMap, and generated Secret. Deleting the PVC removes OpenClaw's claim and access to its persisted data; whether the backing volume and data are deleted depends on the PersistentVolume or StorageClass reclaim policy (`Delete` or `Retain`).

To delete a custom namespace and every workload in it, explicitly opt in:

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh --delete-namespace
```

This also deletes unrelated workloads and the PVC.

## Architecture notes

- The gateway binds to loopback inside the pod by default, so the included setup is for `kubectl port-forward`.
- No cluster-scoped resources; everything lives in a single namespace.
- Security hardening: `readOnlyRootFilesystem`, `drop: ALL` capabilities, non-root user (UID 1000).
- Writable cache: the Gateway stages private SQLite snapshots under `XDG_CACHE_HOME` (default `~/.cache`). The manifest points it at `/home/node/.openclaw/.cache` on the PVC because the root filesystem is read-only. Keep an equivalent writable cache location if you customize the mounts.
- The default config keeps the Control UI on the safer local-access path: loopback bind plus `kubectl port-forward` to `http://127.0.0.1:18789`.
- If you move beyond localhost access, use the supported remote model: HTTPS/Tailscale plus the appropriate gateway bind and Control UI origin settings.
- Secrets are generated in a temp directory and applied directly to the cluster; no secret material is written to the repo checkout.

## File structure

```text
scripts/k8s/
├── deploy.sh                   # Creates namespace + secret, deploys via kustomize
├── create-kind.sh              # Local Kind cluster (auto-detects docker/podman)
└── manifests/
    ├── kustomization.yaml      # Kustomize base
    ├── configmap.yaml          # openclaw.json + AGENTS.md
    ├── deployment.yaml         # Pod spec with security hardening
    ├── pvc.yaml                # 10Gi persistent storage
    └── service.yaml            # ClusterIP on 18789
```

## Related

- [Docker](/install/docker)
- [Docker VM runtime](/install/docker-vm-runtime)
- [Install overview](/install)
