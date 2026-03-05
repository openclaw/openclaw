#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Deploy a collaborative OpenClaw multi-agent gateway to local k3s/k3d.

Usage:
  k3s-up.sh [options]

Options:
  --namespace <name>       Kubernetes namespace (default: openclaw-agents)
  --image <tag>            Local image tag to build/import (default: openclaw:agent-cluster-local)
  --model <provider/model> Model used by all cluster agents (default: openai/gpt-5.2)
  --storage-size <size>    PVC size for OpenClaw state (default: 10Gi)
  --skip-build             Skip docker image build
  --skip-import            Skip k3s/k3d image import
  --smoke                  Run a collaboration smoke turn after rollout
  --help                   Show this help

Environment variables (optional):
  OPENCLAW_GATEWAY_TOKEN   Gateway token (auto-generated if unset)
  OPENAI_API_KEY           OpenAI provider key for model runs
  ANTHROPIC_API_KEY        Anthropic provider key for model runs
  GOOGLE_API_KEY           Google provider key for model runs
  ZAI_API_KEY              Z.AI provider key for model runs
  MINIMAX_API_KEY          MiniMax provider key for model runs
USAGE
}

NAMESPACE="openclaw-agents"
IMAGE="openclaw:agent-cluster-local"
MODEL="openai/gpt-5.2"
STORAGE_SIZE="10Gi"
SKIP_BUILD=0
SKIP_IMPORT=0
RUN_SMOKE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --storage-size)
      STORAGE_SIZE="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-import)
      SKIP_IMPORT=1
      shift
      ;;
    --smoke)
      RUN_SMOKE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

for cmd in docker kubectl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [[ ! -f "$REPO_ROOT/Dockerfile" ]]; then
  echo "Could not find repo Dockerfile at $REPO_ROOT/Dockerfile" >&2
  exit 1
fi

gateway_token="${OPENCLAW_GATEWAY_TOKEN:-}"
if [[ -z "$gateway_token" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    gateway_token="$(openssl rand -hex 24)"
  elif command -v uuidgen >/dev/null 2>&1; then
    gateway_token="$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')"
  else
    gateway_token="token-$(date +%s)"
  fi
  echo "Generated OPENCLAW_GATEWAY_TOKEN for this deployment."
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Building OpenClaw image: $IMAGE"
  docker build -t "$IMAGE" -f "$REPO_ROOT/Dockerfile" "$REPO_ROOT"
fi

context="$(kubectl config current-context 2>/dev/null || true)"
runtime="unknown"
if command -v k3d >/dev/null 2>&1 && [[ "$context" == k3d-* ]]; then
  runtime="k3d"
elif command -v k3s >/dev/null 2>&1; then
  runtime="k3s"
elif [[ "$context" == "docker-desktop" ]] && docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'desktop-worker'; then
  runtime="docker-desktop"
fi

if [[ "$SKIP_IMPORT" -eq 0 ]]; then
  if [[ "$runtime" == "k3d" ]]; then
    cluster_name="${context#k3d-}"
    echo "==> Importing image into k3d cluster: $cluster_name"
    k3d image import "$IMAGE" --cluster "$cluster_name"
  elif [[ "$runtime" == "k3s" ]]; then
    echo "==> Importing image into k3s containerd"
    if k3s ctr images ls >/dev/null 2>&1; then
      docker save "$IMAGE" | k3s ctr images import -
    elif command -v sudo >/dev/null 2>&1; then
      docker save "$IMAGE" | sudo k3s ctr images import -
    else
      echo "Cannot import image into k3s automatically (no permission and sudo unavailable)." >&2
      echo "Run: docker save $IMAGE | sudo k3s ctr images import -" >&2
      exit 1
    fi
  elif [[ "$runtime" == "docker-desktop" ]]; then
    echo "==> Importing image into Docker Desktop Kubernetes (containerd on worker nodes)"
    workers="$(docker ps --filter 'name=desktop-worker' --format '{{.Names}}' 2>/dev/null)"
    if [[ -z "$workers" ]]; then
      echo "No desktop-worker containers found; trying desktop-control-plane." >&2
      workers="$(docker ps --filter 'name=desktop-control-plane' --format '{{.Names}}' 2>/dev/null)"
    fi
    if [[ -z "$workers" ]]; then
      echo "Could not find Docker Desktop node containers." >&2
      echo "Rerun with --skip-import and manually import: docker save $IMAGE | docker exec -i <node> ctr -n k8s.io images import -" >&2
      exit 1
    fi
    for node in $workers; do
      echo "  Importing into $node..."
      docker save "$IMAGE" | docker exec -i "$node" ctr -n k8s.io images import - 2>/dev/null || {
        echo "  Warning: import into $node failed (may be control-plane only)." >&2
      }
    done
  else
    echo "Could not detect a local k3s/k3d/docker-desktop runtime for image import." >&2
    echo "Current kubectl context: ${context:-<none>}." >&2
    echo "This script deploys imagePullPolicy=Never, so local images must be imported into k3s/k3d/docker-desktop." >&2
    echo "Fix: use a k3d context (k3d-*), k3s host, or Docker Desktop with worker nodes." >&2
    echo "If you intentionally use a registry image, rerun with --skip-import and --image <registry/image:tag> after editing pull policy." >&2
    exit 1
  fi
fi

echo "==> Applying namespace: $NAMESPACE"
kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
EOF

optional_secret_keys=(
  OPENAI_API_KEY
  ANTHROPIC_API_KEY
  GOOGLE_API_KEY
  ZAI_API_KEY
  MINIMAX_API_KEY
)

has_provider_key=0
echo "==> Applying secrets"
if ! kubectl -n "$NAMESPACE" get secret openclaw-secrets >/dev/null 2>&1; then
  kubectl -n "$NAMESPACE" create secret generic openclaw-secrets
fi

gateway_token_b64="$(printf '%s' "$gateway_token" | base64 | tr -d '\n')"
kubectl -n "$NAMESPACE" patch secret openclaw-secrets --type merge -p "{\"data\":{\"OPENCLAW_GATEWAY_TOKEN\":\"${gateway_token_b64}\"}}"

for key in "${optional_secret_keys[@]}"; do
  value="${!key:-}"
  if [[ -n "$value" ]]; then
    has_provider_key=1
    value_b64="$(printf '%s' "$value" | base64 | tr -d '\n')"
    kubectl -n "$NAMESPACE" patch secret openclaw-secrets --type merge -p "{\"data\":{\"${key}\":\"${value_b64}\"}}"
  fi
done

if [[ "$has_provider_key" -eq 0 ]]; then
  echo "No provider API keys supplied in env; preserved any existing provider keys in openclaw-secrets."
fi

echo "==> Applying config + storage + gateway (token from openclaw-secrets Secret, not ConfigMap)"
gateway_sts_exists=0
if kubectl -n "$NAMESPACE" get statefulset openclaw-gateway >/dev/null 2>&1; then
  gateway_sts_exists=1
fi

kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: openclaw-config
  namespace: ${NAMESPACE}
data:
  openclaw.json: |
    {
      "gateway": {
        "mode": "local",
        "bind": "loopback",
        "port": 18789,
        "auth": {
          "mode": "token"
        },
        "controlUi": {
          "dangerouslyAllowHostHeaderOriginFallback": true
        }
      },
      "agents": {
        "defaults": {
          "model": {
            "primary": "${MODEL}"
          },
          "sandbox": {
            "mode": "off"
          },
          "subagents": {
            "model": "${MODEL}",
            "thinking": "low",
            "maxConcurrent": 8,
            "archiveAfterMinutes": 120
          }
        },
        "list": [
          {
            "id": "main",
            "default": true,
            "name": "Main",
            "workspace": "/home/node/.openclaw/workspace-main",
            "agentDir": "/home/node/.openclaw/agents/main/agent",
            "model": "${MODEL}"
          },
          {
            "id": "orchestrator",
            "name": "Orchestrator",
            "workspace": "/home/node/.openclaw/workspace-orchestrator",
            "agentDir": "/home/node/.openclaw/agents/orchestrator/agent",
            "model": "${MODEL}",
            "subagents": {
              "allowAgents": ["researcher", "builder", "reviewer"]
            }
          },
          {
            "id": "researcher",
            "name": "Researcher",
            "workspace": "/home/node/.openclaw/workspace-researcher",
            "agentDir": "/home/node/.openclaw/agents/researcher/agent",
            "model": "${MODEL}"
          },
          {
            "id": "builder",
            "name": "Builder",
            "workspace": "/home/node/.openclaw/workspace-builder",
            "agentDir": "/home/node/.openclaw/agents/builder/agent",
            "model": "${MODEL}"
          },
          {
            "id": "reviewer",
            "name": "Reviewer",
            "workspace": "/home/node/.openclaw/workspace-reviewer",
            "agentDir": "/home/node/.openclaw/agents/reviewer/agent",
            "model": "${MODEL}"
          }
        ]
      },
      "tools": {
        "agentToAgent": {
          "enabled": true,
          "allow": ["main", "orchestrator", "researcher", "builder", "reviewer"]
        }
      },
      "session": {
        "agentToAgent": {
          "maxPingPongTurns": 5
        }
      }
    }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: openclaw-state
  namespace: ${NAMESPACE}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${STORAGE_SIZE}
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: openclaw-gateway
  namespace: ${NAMESPACE}
spec:
  serviceName: openclaw-gateway
  replicas: 1
  selector:
    matchLabels:
      app: openclaw-gateway
  template:
    metadata:
      labels:
        app: openclaw-gateway
    spec:
      securityContext:
        fsGroup: 1000
      containers:
        - name: gateway
          image: ${IMAGE}
          imagePullPolicy: Never
          command:
            - node
            - dist/index.js
            - gateway
            - --allow-unconfigured
            - --bind
            - lan
            - --port
            - "18789"
          env:
            - name: OPENCLAW_CONFIG_PATH
              value: /etc/openclaw/openclaw.json
            - name: OPENCLAW_GATEWAY_TOKEN
              valueFrom:
                secretKeyRef:
                  name: openclaw-secrets
                  key: OPENCLAW_GATEWAY_TOKEN
            - name: OPENAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: openclaw-secrets
                  key: OPENAI_API_KEY
                  optional: true
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: openclaw-secrets
                  key: ANTHROPIC_API_KEY
                  optional: true
            - name: GOOGLE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: openclaw-secrets
                  key: GOOGLE_API_KEY
                  optional: true
            - name: ZAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: openclaw-secrets
                  key: ZAI_API_KEY
                  optional: true
            - name: MINIMAX_API_KEY
              valueFrom:
                secretKeyRef:
                  name: openclaw-secrets
                  key: MINIMAX_API_KEY
                  optional: true
          ports:
            - name: gateway
              containerPort: 18789
          readinessProbe:
            tcpSocket:
              port: gateway
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: gateway
            initialDelaySeconds: 30
            periodSeconds: 20
          volumeMounts:
            - name: state
              mountPath: /home/node/.openclaw
            - name: config
              mountPath: /etc/openclaw/openclaw.json
              subPath: openclaw.json
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: openclaw-config
        - name: state
          persistentVolumeClaim:
            claimName: openclaw-state
---
apiVersion: v1
kind: Service
metadata:
  name: openclaw-gateway
  namespace: ${NAMESPACE}
spec:
  selector:
    app: openclaw-gateway
  ports:
    - name: ws
      port: 18789
      targetPort: gateway
  type: ClusterIP
EOF

if [[ "$gateway_sts_exists" -eq 1 ]]; then
  echo "==> Restarting gateway to pick up updated secret env"
  kubectl -n "$NAMESPACE" rollout restart statefulset/openclaw-gateway
fi

echo "==> Waiting for gateway rollout"
kubectl -n "$NAMESPACE" rollout status statefulset/openclaw-gateway --timeout=240s

echo
echo "OpenClaw multi-agent cluster is ready."
echo "Namespace: $NAMESPACE"
echo "Image: $IMAGE"
echo "Model: $MODEL"
echo
echo "Access the gateway from your machine:"
echo "  kubectl -n $NAMESPACE port-forward svc/openclaw-gateway 18789:18789"
echo
echo "Quick smoke test (agent main):"
echo "  kubectl -n $NAMESPACE exec openclaw-gateway-0 -- node dist/index.js agent --local --agent main --message \"reply with OK\""
echo "Run a collaboration turn (orchestrator -> subagents) inside the pod without gateway pairing:"
echo "  kubectl -n $NAMESPACE exec openclaw-gateway-0 -- node dist/index.js agent --local --agent orchestrator --message \"Plan a k3s reliability hardening pass. Use researcher, builder, and reviewer via sessions_spawn, then summarize.\""
echo
echo "Gateway token in cluster secret: openclaw-secrets/OPENCLAW_GATEWAY_TOKEN"

if [[ "$RUN_SMOKE" -eq 1 ]]; then
  if [[ "$has_provider_key" -eq 0 ]]; then
    echo "Skipping smoke turn because no provider API key was supplied."
  else
    echo
    echo "==> Running collaboration smoke turn"
    kubectl -n "$NAMESPACE" exec openclaw-gateway-0 -- node dist/index.js agent --local --agent orchestrator --message "Plan a k3s reliability hardening pass. Use researcher, builder, and reviewer via sessions_spawn, then summarize in 5 bullets." --timeout 180
  fi
fi
