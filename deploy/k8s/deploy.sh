#!/bin/bash
# Mythos-Class Kubernetes Deployment Script
# Deploys Mythos to Kubernetes with all components

set -e

NAMESPACE="mythos"
CONTEXT="${1:-default}"

echo "🦞 Deploying Mythos-Class to Kubernetes"
echo "========================================"
echo ""
echo "Namespace: ${NAMESPACE}"
echo "Context: ${CONTEXT}"
echo ""

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "❌ kubectl not found. Please install kubectl first."
    exit 1
fi

# Check if context exists
if ! kubectl config get-contexts "${CONTEXT}" &> /dev/null; then
    echo "❌ Kubernetes context '${CONTEXT}' not found"
    echo "Available contexts:"
    kubectl config get-contexts
    exit 1
fi

# Use specified context
kubectl config use-context "${CONTEXT}"

# Create namespace if it doesn't exist
echo "📦 Creating namespace..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# Create secrets from environment variables
echo "🔐 Creating secrets..."
if [ -z "${OPENCLAW_GATEWAY_TOKEN}" ]; then
    echo "❌ OPENCLAW_GATEWAY_TOKEN not set"
    exit 1
fi

kubectl create secret generic mythos-secrets \
  --namespace "${NAMESPACE}" \
  --from-literal=OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN}" \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  --from-literal=GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
  --from-literal=TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}" \
  --from-literal=DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}" \
  --from-literal=SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}" \
  --from-literal=GITHUB_TOKEN="${GITHUB_TOKEN:-}" \
  --from-literal=PG_PASSWORD="${PG_PASSWORD:-changeme}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Apply all manifests
echo "🚀 Applying Kubernetes manifests..."
kubectl apply -f deploy/k8s/mythos-deployment.yaml --namespace "${NAMESPACE}"

# Wait for deployments to be ready
echo "⏳ Waiting for deployments..."
kubectl rollout status deployment/mythos-gateway --namespace "${NAMESPACE}" --timeout=300s
kubectl rollout status deployment/mythos-redis --namespace "${NAMESPACE}" --timeout=120s
kubectl rollout status statefulset/mythos-postgres --namespace "${NAMESPACE}" --timeout=180s

echo ""
echo "✅ Mythos-Class deployed successfully!"
echo ""
echo "To check status:"
echo "  kubectl get pods -n mythos"
echo "  kubectl get svc -n mythos"
echo ""
echo "To view logs:"
echo "  kubectl logs -f deployment/mythos-gateway -n mythos"
echo ""
echo "To access gateway:"
echo "  kubectl port-forward svc/mythos-gateway 18789:18789 -n mythos"
echo "  Then open: http://localhost:18789"
echo ""
