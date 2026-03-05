---
name: kubectl
description: Use kubectl to inspect and operate Kubernetes clusters with safe defaults and common troubleshooting commands.
homepage: https://kubernetes.io/docs/reference/kubectl/
metadata:
  {
    "openclaw":
      {
        "emoji": "☸️",
        "requires": { "bins": ["kubectl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "kubernetes-cli",
              "bins": ["kubectl"],
              "label": "Install kubectl (brew)",
            },
          ],
      },
  }
---

# kubectl

Use `kubectl` for Kubernetes cluster inspection, debugging, and controlled changes.

Safety

- Prefer read-only commands first (`get`, `describe`, `logs`).
- Confirm context + namespace before making changes.
- For destructive operations (`delete`, `rollout undo`, force flags), ask for explicit confirmation.
- Prefer targeted resources over broad selectors when changing live workloads.

Setup checks

- Client/server version: `kubectl version`
- Current context: `kubectl config current-context`
- Contexts: `kubectl config get-contexts`
- Switch context: `kubectl config use-context <context>`
- Set default namespace for current context: `kubectl config set-context --current --namespace=<ns>`

Read-only basics

- Namespaces: `kubectl get ns`
- Workloads in namespace: `kubectl get deploy,sts,ds -n <ns>`
- Pods wide view: `kubectl get pods -n <ns> -o wide`
- Services + endpoints: `kubectl get svc,endpoints -n <ns>`
- Events (newest first): `kubectl get events -n <ns> --sort-by=.metadata.creationTimestamp`
- Resource details: `kubectl describe pod <pod> -n <ns>`

Logs + debugging

- Pod logs: `kubectl logs <pod> -n <ns>`
- Follow logs: `kubectl logs -f <pod> -n <ns>`
- Specific container: `kubectl logs <pod> -c <container> -n <ns>`
- Previous crash logs: `kubectl logs <pod> -c <container> -n <ns> --previous`
- Exec shell: `kubectl exec -it <pod> -n <ns> -- sh`
- Port-forward service: `kubectl port-forward svc/<svc> 8080:80 -n <ns>`

Apply + patch

- Preview apply: `kubectl apply -f <file-or-dir> -n <ns> --dry-run=server -o yaml`
- Apply manifests: `kubectl apply -f <file-or-dir> -n <ns>`
- Delete manifests: `kubectl delete -f <file-or-dir> -n <ns>`
- Restart deployment: `kubectl rollout restart deploy/<name> -n <ns>`
- Update image: `kubectl set image deploy/<name> <container>=<image>:<tag> -n <ns>`
- Quick patch replicas: `kubectl patch deploy/<name> -n <ns> -p '{"spec":{"replicas":3}}'`

Rollout management

- Rollout status: `kubectl rollout status deploy/<name> -n <ns>`
- Rollout history: `kubectl rollout history deploy/<name> -n <ns>`
- Roll back: `kubectl rollout undo deploy/<name> -n <ns>`

Cluster + node checks

- Nodes: `kubectl get nodes -o wide`
- Node details: `kubectl describe node <node>`
- Top nodes/pods (metrics-server required): `kubectl top nodes` / `kubectl top pods -n <ns>`

Useful filters

- Label selector: `kubectl get pods -n <ns> -l app=<app>`
- Custom columns: `kubectl get pods -n <ns> -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,NODE:.spec.nodeName`
- JSONPath quick lookup: `kubectl get pod <pod> -n <ns> -o jsonpath='{.status.podIP}'`

When uncertain

1. Confirm target cluster/context.
2. Confirm namespace + resource name.
3. Run read-only checks first.
4. Then apply the smallest safe change.
