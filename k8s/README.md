# OpenClaw Kubernetes Deployment

This directory contains standard Kubernetes manifests for deploying OpenClaw Gateway.

## Prerequisites

- A running Kubernetes cluster (k8s or k3s).
- `kubectl` configured to communicate with your cluster.
- An OpenClaw Docker image (either pulled from a registry or built locally and imported).

## Community Helm Charts

If you prefer using Helm, there are community-maintained charts available:

- **[Chrisbattarbee/openclaw-helm](https://github.com/Chrisbattarbee/openclaw-helm)**: A comprehensive chart with support for configuration injection, persistence, and ingress.
- **[serhanekicii/openclaw-helm](https://github.com/serhanekicii/openclaw-helm)**: Another popular community chart.

## Setup Instructions

### 1. Configure Secrets

Edit `secret.yaml` to set your secure gateway token.

```bash
# Generate a token
openssl rand -hex 32

# Update the file
nano secret.yaml
```

### 2. Apply Manifests

Apply the configuration in the following order:

```bash
kubectl apply -f secret.yaml
kubectl apply -f pvc.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
```

### 3. Verify Deployment

Check the status of the pods:

```bash
kubectl get pods
kubectl logs -f deployment/openclaw-gateway
```

## Accessing the Gateway

By default, the service is of type `ClusterIP`. To access it:

- **Port Forwarding:**

  ```bash
  kubectl port-forward service/openclaw-service 18789:18789
  ```

- **NodePort / LoadBalancer:**
  Edit `service.yaml` and change `type: ClusterIP` to `NodePort` or `LoadBalancer`.

## Customization

- **Image:** Update `deployment.yaml` to point to your specific Docker image tag.
- **Resources:** Adjust CPU and memory limits in `deployment.yaml` based on your cluster capacity.
- **Storage:** Check `pvc.yaml` to adjust the storage size (default 10Gi).
