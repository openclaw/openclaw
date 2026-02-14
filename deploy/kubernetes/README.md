# OpenClaw on Kubernetes

This directory contains everything needed to run the OpenClaw gateway on Kubernetes
without modifying the upstream core:

- A Helm chart (`deploy/kubernetes/charts/openclaw`) that packages the gateway
  Deployment, Service, PVCs, optional Ingress, and supporting resources.
- Kustomize overlays (`deploy/kubernetes/kustomize`) that render the Helm chart so
  it can be managed by Flux, Argo CD, or raw `kustomize build` workflows.

## Helm chart overview

| Component | Purpose |
|-----------|---------|
| `Deployment` | Runs the `ghcr.io/openclaw/openclaw` container. You can override the command/args if you need to pass `gateway` flags. |
| `Service` | Exposes the gateway (18789) and bridge (18790) ports inside the cluster. |
| `Ingress` | Optional HTTP ingress for the primary port. |
| `PVCs` | Two state volumes: `/home/node/.openclaw` (config) and `/home/node/.openclaw/workspace` (project files). Both can be swapped for existing claims or disabled in favor of emptyDir. |
| `Secret` | Optional helper to materialize `OPENCLAW_GATEWAY_TOKEN` and other credentials. It is referenced via `envFrom`, so you can supply any key/value pairs the gateway expects. |

Key values (see `values.yaml` for the full list):

- `image.repository` / `image.tag` – defaults to the published GitHub Container Registry image. Override the tag to pin a release.
- `gateway.env`, `gateway.args`, `gateway.extraEnvFrom` – inject tokens, model credentials, or additional CLI flags.
- `persistence.config` / `persistence.workspace` – size and storage class for your state PVCs. Set `existingClaim` to bind to an already-provisioned volume.
- `initContainers.enabled` – runs a tiny BusyBox init step to create `/home/node/.openclaw/workspace` and fix ownership (UID 1000). Disable it if your CSI driver already handles permissions.
- `extraContainers`, `extraVolumes`, `extraVolumeMounts` – attach browser sidecars or debugging tools without touching the upstream image.

Install directly with Helm:

```bash
helm upgrade --install openclaw \
  ./deploy/kubernetes/charts/openclaw \
  --namespace openclaw --create-namespace \
  --set secret.create=true \
  --set secret.stringData.OPENCLAW_GATEWAY_TOKEN="REPLACE_ME" \
  --set image.tag=v2026.2.13
```

## Kustomize overlays

Flux and Argo CD both understand native Kustomize. Each overlay renders the Helm
chart with an environment-specific values file.

```
deploy/kubernetes/kustomize
├── base            # Namespace definition
└── overlays
    ├── dev         # Single replica, smaller PVCs, sample secret
    └── prod        # Two replicas, Ingress + TLS, external secret reference
```

Render an overlay locally:

```bash
kustomize build deploy/kubernetes/kustomize/overlays/dev
```

### Flux example

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: openclaw
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/egkristi/openclaw
  ref:
    branch: feature/k8s
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: openclaw
  namespace: flux-system
spec:
  interval: 5m
  path: ./deploy/kubernetes/kustomize/overlays/prod
  prune: true
  sourceRef:
    kind: GitRepository
    name: openclaw
```

### Argo CD example

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: openclaw
spec:
  destination:
    namespace: openclaw
    server: https://kubernetes.default.svc
  project: default
  source:
    repoURL: https://github.com/egkristi/openclaw.git
    targetRevision: feature/k8s
    path: deploy/kubernetes/kustomize/overlays/dev
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Secrets & security

- **Do not commit real gateway tokens**. For production, set `secret.create=false`
  and reference a secret managed by your secret store (SOPS, External Secrets,
  sealed-secrets, etc.).
- The included ServiceAccount runs without extra permissions. Attach Roles only if
  you extend OpenClaw with cluster integrations that need them.
- The Deployment runs as user `node` (UID 1000) with `allowPrivilegeEscalation=false`.
  Adjust the `securityContext` if you embed privileged sidecars.

## Extending the stack

- Attach a GUI/Chromium sidecar by adding another container via
  `extraContainers` and wiring shared PVCs through `extraVolumes`. This keeps
  the upstream OpenClaw image untouched while still satisfying bot-detection
  requirements.
- Add monitoring by turning on the annotations under `service.annotations` and
  scraping the `/healthz` endpoint.
- Customize ingress, TLS, and network policies via standard Helm/Kustomize
  patterns without patching the OpenClaw sources.
