---
summary: Deploy OpenClaw Gateway to a Kubernetes cluster with Kustomize
read_when:
  - You want to run OpenClaw on a Kubernetes cluster
  - You want to test OpenClaw in a Kubernetes environment
title: Kubernetes
---

# OpenClaw 在 Kubernetes 上的部署

這是一個在 Kubernetes 上執行 OpenClaw 的最小起點範例 — 並非生產環境可用的部署。它涵蓋了核心資源，並且設計上可依您的環境進行調整。

## 為什麼不使用 Helm？

OpenClaw 是一個單一容器搭配一些設定檔。真正有趣的客製化在於 agent 內容（markdown 檔案、技能、設定覆寫），而非基礎架構模板。Kustomize 可以處理覆寫，且不會有 Helm chart 的額外負擔。如果您的部署變得更複雜，可以在這些 manifest 之上再加一層 Helm chart。

## 您需要準備的專案

- 一個執行中的 Kubernetes 叢集（AKS、EKS、GKE、k3s、kind、OpenShift 等）
- `kubectl` 已連接至您的叢集
- 至少一個模型提供者的 API 金鑰

## 快速開始

bash

# 請替換為您的提供者：ANTHROPIC、GEMINI、OPENAI 或 OPENROUTER

export <PROVIDER>\_API_KEY="..."
./scripts/k8s/deploy.sh

kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789

取得 gateway token 並貼到控制介面：

```bash
kubectl get secret openclaw-secrets -n openclaw -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d
```

若要本地除錯，`./scripts/k8s/deploy.sh --show-token` 會在部署後印出 token。

## 使用 Kind 進行本地測試

如果您沒有叢集，可以使用 [Kind](https://kind.sigs.k8s.io/) 在本地建立一個：

```bash
./scripts/k8s/create-kind.sh           # auto-detects docker or podman
./scripts/k8s/create-kind.sh --delete  # tear down
```

然後照常使用 `./scripts/k8s/deploy.sh` 部署。

## 步驟說明

### 1) 部署

**選項 A** — 在環境變數中設定 API key（一步完成）：

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh
```

此腳本會建立一個包含 API key 及自動產生的 gateway token 的 Kubernetes Secret，接著進行部署。如果 Secret 已存在，則會保留目前的 gateway token 以及未被更改的提供者金鑰。

**選項 B** — 分開建立 Secret：

```bash
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

如果想要在本地測試時將 token 輸出到 stdout，可以在任一指令中使用 `--show-token`。

### 2) 存取 gateway

```bash
kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

## 部署內容

```
Namespace: openclaw (configurable via OPENCLAW_NAMESPACE)
├── Deployment/openclaw        # Single pod, init container + gateway
├── Service/openclaw           # ClusterIP on port 18789
├── PersistentVolumeClaim      # 10Gi for agent state and config
├── ConfigMap/openclaw-config  # openclaw.json + AGENTS.md
└── Secret/openclaw-secrets    # Gateway token + API keys
```

## 自訂設定

### Agent 指令說明

編輯 `AGENTS.md` 於 `scripts/k8s/manifests/configmap.yaml` 並重新部署：

```bash
./scripts/k8s/deploy.sh
```

### Gateway 設定

編輯 `openclaw.json` 於 `scripts/k8s/manifests/configmap.yaml`。完整參考請見 [Gateway configuration](/gateway/configuration)。

### 新增提供者

重新執行並匯出額外的金鑰：

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

現有的提供者金鑰會保留在 Secret 中，除非你覆寫它們。

或直接 patch Secret：

```bash
kubectl patch secret openclaw-secrets -n openclaw \
  -p '{"stringData":{"<PROVIDER>_API_KEY":"..."}}'
kubectl rollout restart deployment/openclaw -n openclaw
```

### 自訂命名空間

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh
```

### 自訂映像檔

編輯 `image` 欄位於 `scripts/k8s/manifests/deployment.yaml`：

```yaml
image: ghcr.io/openclaw/openclaw:2026.3.1
```

### 透過 port-forward 以外的方式暴露

預設的清單將 gateway 綁定在 Pod 內的 loopback。這對 `kubectl port-forward` 有效，但對需要存取 Pod IP 的 Kubernetes `Service` 或 Ingress 路徑則無效。

如果你想透過 Ingress 或負載平衡器暴露 gateway：

- 將 `scripts/k8s/manifests/configmap.yaml` 中 gateway 的綁定從 `loopback` 改為符合你部署模型的非 loopback 綁定
- 保持 gateway 認證啟用，並使用適當的 TLS 終止入口點
- 使用支援的網頁安全模型（例如 HTTPS/Tailscale Serve 及必要時明確允許的來源）設定 Control UI 以供遠端存取

## 重新部署

```bash
./scripts/k8s/deploy.sh
```

此指令會套用所有清單並重新啟動 Pod，以載入任何設定或密鑰的變更。

## 拆除

```bash
./scripts/k8s/deploy.sh --delete
```

此指令會刪除該命名空間及其中所有資源，包括 PVC。

## 架構說明

- gateway 預設綁定在 Pod 內的 loopback，因此內建設定適用於 `kubectl port-forward`
- 無叢集範圍資源 — 所有資源皆存在單一命名空間
- 安全性：`readOnlyRootFilesystem`、`drop: ALL` 權限，非 root 使用者（UID 1000）
- 預設設定將 Control UI 維持在較安全的本地存取路徑：loopback 綁定加上 `kubectl port-forward` 至 `http://127.0.0.1:18789`
- 若要超越 localhost 存取，請使用支援的遠端模型：HTTPS/Tailscale 加上適當的 gateway 綁定及 Control UI 來源設定
- 密鑰會在暫存目錄產生並直接套用到叢集 — 不會將密鑰內容寫入原始碼庫檢出目錄

## 檔案結構

```
scripts/k8s/
├── deploy.sh                   # Creates namespace + secret, deploys via kustomize
├── create-kind.sh              # Local Kind cluster (auto-detects docker/podman)
└── manifests/
    ├── kustomization.yaml      # Kustomize base
    ├── configmap.yaml          # openclaw.json + AGENTS.md
    ├── deployment.yaml         # Pod spec with security hardening
    ├── pvc.yaml                # 10Gi persistent storage
    └── service.yaml            # ClusterIP on 18789
```
