#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  k3s-local-up.sh --game-data /absolute/path/to/claw-data [--image openclaw:web-k3s-local] [--namespace retro-games] [--source-repo https://github.com/pstagner/OpenClaw.git] [--source-ref main]

Options:
  --game-data   Required. Host path with Claw assets (IMAGES/, SOUNDS/, *.WWD, *.PID).
  --image       Docker image tag to build/import/deploy. Default: openclaw:web-k3s-local
  --namespace   Kubernetes namespace. Default: retro-games
  --source-repo Git repository to build game binary from. Default: https://github.com/pstagner/OpenClaw.git
  --source-ref  Optional git branch/tag/commit to clone from source repo.
  --skip-build  Skip docker build step.
  --skip-import Skip image import step (if your cluster can already pull the image).
USAGE
}

IMAGE="openclaw:web-k3s-local"
NAMESPACE="retro-games"
SOURCE_REPO="https://github.com/pstagner/OpenClaw.git"
SOURCE_REF=""
GAME_DATA_DIR=""
SKIP_BUILD=0
SKIP_IMPORT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --game-data)
      GAME_DATA_DIR="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    --source-repo)
      SOURCE_REPO="${2:-}"
      shift 2
      ;;
    --source-ref)
      SOURCE_REF="${2:-}"
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

if [[ -z "$GAME_DATA_DIR" ]]; then
  echo "--game-data is required" >&2
  usage
  exit 2
fi

if [[ ! -d "$GAME_DATA_DIR" ]]; then
  echo "Game data directory does not exist: $GAME_DATA_DIR" >&2
  exit 1
fi

for cmd in docker kubectl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

GAME_DATA_DIR="$(cd "$GAME_DATA_DIR" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Building image: $IMAGE"
  build_cmd=(
    docker build
    -t "$IMAGE"
    -f "$ROOT_DIR/Dockerfile.web"
    --build-arg "OPENCLAW_SOURCE_REPO=$SOURCE_REPO"
  )
  if [[ -n "$SOURCE_REF" ]]; then
    build_cmd+=(--build-arg "OPENCLAW_SOURCE_REF=$SOURCE_REF")
  fi
  build_cmd+=("$ROOT_DIR")
  "${build_cmd[@]}"
fi

if [[ "$SKIP_IMPORT" -eq 0 ]]; then
  CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
  if command -v k3d >/dev/null 2>&1 && [[ "$CONTEXT" == k3d-* ]]; then
    CLUSTER_NAME="${CONTEXT#k3d-}"
    echo "==> Importing image into k3d cluster: $CLUSTER_NAME"
    k3d image import "$IMAGE" --cluster "$CLUSTER_NAME"
  elif command -v k3s >/dev/null 2>&1; then
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
  else
    echo "Could not detect k3d or k3s image importer." >&2
    echo "If your cluster cannot pull '$IMAGE', import it manually and rerun with --skip-import." >&2
  fi
fi

yaml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

IMAGE_YAML="$(yaml_escape "$IMAGE")"
NAMESPACE_YAML="$(yaml_escape "$NAMESPACE")"
GAME_DATA_DIR_YAML="$(yaml_escape "$GAME_DATA_DIR")"

echo "==> Applying k3s-local manifests in namespace: $NAMESPACE"
kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: "${NAMESPACE_YAML}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw-web
  namespace: "${NAMESPACE_YAML}"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: openclaw-web
  template:
    metadata:
      labels:
        app: openclaw-web
    spec:
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: openclaw-web
          image: "${IMAGE_YAML}"
          imagePullPolicy: Never
          ports:
            - containerPort: 6080
              name: novnc
          env:
            - name: XVFB_WHD
              value: 1280x720x24
            - name: NOVNC_PORT
              value: "6080"
            - name: VNC_PORT
              value: "5900"
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 1Gi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 10001
            runAsGroup: 10001
            capabilities:
              drop:
                - ALL
          volumeMounts:
            - name: game-data
              mountPath: /game
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: game-data
          hostPath:
            path: "${GAME_DATA_DIR_YAML}"
            type: Directory
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: openclaw-web
  namespace: "${NAMESPACE_YAML}"
spec:
  type: ClusterIP
  selector:
    app: openclaw-web
  ports:
    - name: http
      port: 80
      targetPort: 6080
EOF

echo "==> Waiting for deployment rollout"
kubectl -n "$NAMESPACE" rollout status deployment/openclaw-web --timeout=180s

echo
echo "OpenClaw on local k3s is ready."
echo "Access it with:"
echo "  kubectl -n $NAMESPACE port-forward svc/openclaw-web 6080:80"
echo "Then open:"
echo "  http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote"
