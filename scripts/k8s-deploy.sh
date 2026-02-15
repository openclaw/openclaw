#!/usr/bin/env bash
set -euo pipefail

# k8s-deploy.sh
# Deploys OpenClaw to the current Kubernetes context.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
K8S_DIR="$ROOT_DIR/k8s"

echo "==> OpenClaw Kubernetes Deployer"

if ! command -v kubectl >/dev/null 2>&1; then
    echo "Error: kubectl is not installed."
    exit 1
fi

# Check connection
if ! kubectl cluster-info >/dev/null 2>&1; then
    echo "Error: Cannot connect to Kubernetes cluster."
    exit 1
fi

echo "==> Cluster: $(kubectl config current-context)"

# Generate Token if not set
TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
    echo "Generating secure gateway token..."
    TOKEN="$(openssl rand -hex 32)"
    echo "Token: $TOKEN"
fi

echo "==> Applying Secrets..."
# We use imperative creation to avoid storing the secret in git, 
# or we render the template.
# Let's verify if secret exists
if kubectl get secret openclaw-secret >/dev/null 2>&1; then
    echo "Secret 'openclaw-secret' already exists. Skipping creation."
else
    kubectl create secret generic openclaw-secret \
        --from-literal=OPENCLAW_GATEWAY_TOKEN="$TOKEN"
    echo "Secret 'openclaw-secret' created."
fi

echo "==> Applying Manifests..."
kubectl apply -f "$K8S_DIR/pvc.yaml"
kubectl apply -f "$K8S_DIR/deployment.yaml"
kubectl apply -f "$K8S_DIR/service.yaml"

echo ""
echo "==> Deployment initiated."
echo "Check status with: kubectl get pods -l app=openclaw"
echo "Gateway Token: $TOKEN"
