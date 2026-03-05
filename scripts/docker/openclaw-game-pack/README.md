# OpenClaw Game Container Pack

This bundle provides production-ready container patterns for OpenClaw (the game):

- Hardened non-root runtime image
- GPU-capable OpenGL image
- Browser-playable image (Xvfb + noVNC)
- Kubernetes deployment manifests
- Retro gaming pack (multiple browser-playable game services)

All commands below run from:

```bash
cd scripts/docker/openclaw-game-pack
```

Source defaults:

- `OPENCLAW_SOURCE_REPO=https://github.com/pstagner/OpenClaw.git`
- `OPENCLAW_SOURCE_REF` is optional (branch/tag/commit)

## 1) Hardened non-root Dockerfile

Build:

```bash
docker build -t openclaw:hardened -f Dockerfile.hardened .
```

Build from a specific ref:

```bash
docker build -t openclaw:hardened -f Dockerfile.hardened \
  --build-arg OPENCLAW_SOURCE_REPO=https://github.com/pstagner/OpenClaw.git \
  --build-arg OPENCLAW_SOURCE_REF=main .
```

Run with host X11:

```bash
xhost +local:docker

docker run --rm \
  -e DISPLAY=$DISPLAY \
  -v /tmp/.X11-unix:/tmp/.X11-unix:rw \
  -v "$HOME/games/claw-data:/game:rw" \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --read-only \
  --tmpfs /tmp \
  --tmpfs /run \
  openclaw:hardened
```

## 2) GPU-accelerated OpenGL container

Build and run via compose:

```bash
xhost +local:docker
GAME_DATA_DIR="$HOME/games/claw-data" \
OPENCLAW_SOURCE_REPO="https://github.com/pstagner/OpenClaw.git" \
OPENCLAW_SOURCE_REF="main" \
docker compose -f docker-compose.gpu.yml up --build
```

Notes:

- Intel/AMD Mesa path uses `/dev/dri` bind.
- NVIDIA path expects NVIDIA Container Toolkit and Compose GPU support.

## 3) Headless browser-playable OpenClaw

Build and run:

```bash
GAME_DATA_DIR="$HOME/games/claw-data" \
OPENCLAW_SOURCE_REPO="https://github.com/pstagner/OpenClaw.git" \
OPENCLAW_SOURCE_REF="main" \
docker compose -f docker-compose.web.yml up --build
```

Open:

- http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote

Optional password-protected VNC:

```bash
VNC_PASSWORD='change-me' GAME_DATA_DIR="$HOME/games/claw-data" docker compose -f docker-compose.web.yml up --build
```

## 4) Kubernetes deployment

### Local k3s quickstart (testable)

Use the helper script to build, import, and deploy to a local `k3s`/`k3d` cluster with your real Claw data mounted from host:

```bash
./k8s/k3s-local-up.sh \
  --game-data "$HOME/games/claw-data" \
  --source-repo "https://github.com/pstagner/OpenClaw.git" \
  --source-ref "main"
```

Then in another terminal:

```bash
kubectl -n retro-games port-forward svc/openclaw-web 6080:80
```

Open:

- http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote

Teardown:

```bash
./k8s/k3s-local-down.sh
```

### Generic cluster flow

1. Build/push the web image and update image reference in `k8s/openclaw-web-deployment.yaml`.
2. Apply manifests:

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/openclaw-pvc.yaml
kubectl apply -f k8s/openclaw-web-deployment.yaml
kubectl apply -f k8s/openclaw-web-service.yaml
```

Optional ingress:

```bash
kubectl apply -f k8s/openclaw-web-ingress.yaml
```

Optional GPU patch (clusters with NVIDIA device plugin):

```bash
kubectl patch deployment openclaw-web -n retro-games --type merge --patch-file k8s/openclaw-web-gpu-patch.yaml
```

## 5) Retro gaming container pack (multiple games)

This stack starts three browser-playable services:

- OpenClaw on port `6080`
- OpenTyrian on port `6081`
- SuperTuxKart on port `6082`

Run:

```bash
cd retro-pack
OPENCLAW_DATA_DIR="$HOME/games/claw-data" docker compose up --build
```

Open in browser:

- http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=remote
- http://127.0.0.1:6081/vnc.html?autoconnect=1&resize=remote
- http://127.0.0.1:6082/vnc.html?autoconnect=1&resize=remote
