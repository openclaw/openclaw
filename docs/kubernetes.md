# OpenClaw on Kubernetes

Running OpenClaw inside Kubernetes keeps the upstream code untouched while letting you
compose sidecars, declarative secrets, GitOps pipelines, and HA upgrades. This guide
covers the packaged Helm chart, Kustomize overlays, and GitOps workflows.

## Architecture

Kubernetes hosts the gateway container alongside any helper sidecars (browser, cron,
model runners). Persistent volumes provide `/home/node/.openclaw` state, while services
expose the gateway and bridge ports.

```mermaid
graph TD
    subgraph Cluster[Kubernetes Cluster]
        subgraph NS[Namespace: openclaw]
            PVC1[(PVC: config)]
            PVC2[(PVC: workspace)]
            subgraph Deploy[Deployment: openclaw]
                OC[Container: ghcr.io/openclaw/openclaw]
                SB[Optional sidecar(s)]
            end
            SVC((Service: gateway/bridge))
        end
    end

    OC --> PVC1
    OC --> PVC2
    SB -. shared volume .-> PVC2
    Deploy --> SVC
    SVC -->|18789| Users
    SVC -->|18790| Bridges/Tunnels
```

Flux or Argo CD reconcile the chart via Kustomize overlays, keeping the cluster in sync
with git.

```mermaid
sequenceDiagram
    participant Developer
    participant GitHub
    participant GitOps as Flux/Argo
    participant Cluster

    Developer->>GitHub: Commit chart/overlay changes
    GitOps->>GitHub: Poll repo
    GitOps-->>GitOps: Render Kustomize (Helm chart)
    GitOps->>Cluster: Apply manifests (Deployment, Service, PVCs)
    Cluster-->>GitOps: Status/health
    GitOps-->>Developer: Sync status (optional UIs/alerts)
```

## Helm chart (`deploy/kubernetes/charts/openclaw`)

The chart deploys:

- `Deployment` running `ghcr.io/openclaw/openclaw`
- `Service` exposing ports 18789 (gateway) + 18790 (bridge)
- Optional `Ingress`
- PVCs for `/home/node/.openclaw` and `/home/node/.openclaw/workspace`
- Optional Secret (for `OPENCLAW_GATEWAY_TOKEN`, OAuth creds, etc.)
- BusyBox init container to fix permissions on shared volumes

Key values (`values.yaml`):

| Value | Purpose |
|-------|---------|
| `image.repository/tag/pullPolicy` | Pin the OpenClaw container release. |
| `gateway.env/args` | Inject CLI flags or env vars (model keys, bind mode). |
| `secret.create/stringData` | Inline secret creation. Set `secret.create=false` to reference an external secret. |
| `persistence.{config,workspace}` | Size, accessMode, storageClass, or reuse `existingClaim`. |
| `extraContainers/extraVolumes` | Attach GUI browsers, proxies, etc., without modifying upstream images. |
| `ingress.*` | Enable HTTP ingress + TLS. |

Install directly:

```bash
helm upgrade --install openclaw \
  ./deploy/kubernetes/charts/openclaw \
  --namespace openclaw --create-namespace \
  --set image.tag=v2026.2.13 \
  --set secret.create=true \
  --set secret.stringData.OPENCLAW_GATEWAY_TOKEN="REPLACE_ME"
```

## Kustomize overlays (`deploy/kubernetes/kustomize`)

- `base/` – namespace definition (openclaw)
- `overlays/dev` – single replica, smaller PVCs, sample secret
- `overlays/prod` – two replicas, ingress + TLS, references external secret

Render locally:

```bash
kustomize build deploy/kubernetes/kustomize/overlays/dev
```

### Flux example

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: openclaw
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

- **Never commit real tokens.** Use `secret.create=false` and reference a secret from
  External Secrets, SOPS, or your cloud secret manager.
- ServiceAccount is minimal by default. Add Roles/Bindings only if sidecars need API
  access.
- The Deployment runs as UID 1000 (`node`). Adjust `securityContext` if a sidecar needs
  elevated privileges.

## Sidecars & extensions

1. Add a browser/GUI container via `extraContainers`. Mount the same workspace PVC to
   share cookies or session files.
2. Use `extraVolumes` + `extraVolumeMounts` for shared Unix sockets or cache dirs.
3. Wire Prometheus scraping by enabling service annotations (`prometheus.io/*`).
4. Attach NetworkPolicies or ServiceMonitors outside the chart via additional manifests in
   your overlay.

## Upstream compatibility

All Kubernetes assets live under `deploy/kubernetes/*` plus documentation links, so they
can track the official upstream repo without touching core code. Regularly merge upstream
`main` into your branch to stay current; conflicts are unlikely unless upstream eventually
ships their own Kubernetes package (in which case you can upstream these files or adapt).
