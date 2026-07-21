#!/bin/bash
# Mythos-Class Kubernetes Undeploy Script
# Removes all Mythos resources from Kubernetes

set -e

NAMESPACE="mythos"

echo "🗑️  Removing Mythos-Class from Kubernetes"
echo "=========================================="
echo ""
echo "Namespace: ${NAMESPACE}"
echo ""

# Confirm deletion
read -p "Are you sure you want to delete all Mythos resources? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# Delete all resources
echo "📦 Deleting deployments..."
kubectl delete -f deploy/k8s/mythos-deployment.yaml --namespace "${NAMESPACE}" --ignore-not-found=true

# Delete secrets
echo "🔐 Deleting secrets..."
kubectl delete secret mythos-secrets --namespace "${NAMESPACE}" --ignore-not-found=true

# Delete namespace
echo "🗂️  Deleting namespace..."
kubectl delete namespace "${NAMESPACE}" --ignore-not-found=true

echo ""
echo "✅ Mythos-Class removed successfully!"
