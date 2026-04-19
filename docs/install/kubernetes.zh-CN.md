---
summary: "使用 Kustomize 将 OpenClaw Gateway 部署到 Kubernetes 集群"
read_when:
  - 你想在 Kubernetes 集群上运行 OpenClaw
  - 你想在 Kubernetes 环境中测试 OpenClaw
title: "Kubernetes"
---

# 在 Kubernetes 上运行 OpenClaw

在 Kubernetes 上运行 OpenClaw 的最小起点 —— 不是生产就绪的部署。它涵盖核心资源，旨在适应你的环境。

## 为什么不使用 Helm？

OpenClaw 是一个带有一些配置文件的单个容器。有趣的定制在于代理内容（Markdown 文件、技能、配置覆盖），而不是基础设施模板。Kustomize 处理覆盖，没有 Helm chart 的开销。如果你的部署变得更加复杂，可以在这些清单之上分层 Helm chart。

## 你需要什么

- 一个运行中的 Kubernetes 集群（AKS、EKS、GKE、k3s、kind、OpenShift 等）
- 连接到集群的 `kubectl`
- 至少一个模型提供商的 API 密钥

## 快速开始

```bash
# 替换为你的提供商：ANTHROPIC、GEMINI、OPENAI 或 OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh

kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

检索 Control UI 的配置共享密钥。此部署脚本默认创建令牌认证：

```bash
kubectl get secret openclaw-secrets -n openclaw -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d
```

对于本地调试，`./scripts/k8s/deploy.sh --show-token` 在部署后打印令牌。

## 使用 Kind 进行本地测试

如果你没有集群，可以使用 [Kind](https://kind.sigs.k8s.io/) 在本地创建一个：

```bash
./scripts/k8s/create-kind.sh           # 自动检测 docker 或 podman
./scripts/k8s/create-kind.sh --delete  # 拆除
```

然后使用 `./scripts/k8s/deploy.sh` 正常部署。

## 分步指南

### 1) 部署

**选项 A** — 环境中的 API 密钥（一步）：

```bash
# 替换为你的提供商：ANTHROPIC、GEMINI、OPENAI 或 OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh
```

该脚本创建一个带有 API 密钥和自动生成的网关令牌的 Kubernetes Secret，然后部署。如果 Secret 已存在，它会保留当前的网关令牌和任何未更改的提供商密钥。

**选项 B** — 单独创建 secret：

```bash
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

如果你希望令牌打印到 stdout 以供本地测试，请在任一命令中使用 `--show-token`。

### 2) 访问网关

```bash
kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

## 部署的内容

```
命名空间：openclaw（可通过 OPENCLAW_NAMESPACE 配置）
├── Deployment/openclaw        # 单个 Pod，初始化容器 + 网关
├── Service/openclaw           # 端口 18789 上的 ClusterIP
├── PersistentVolumeClaim      # 10Gi 用于代理状态和配置
├── ConfigMap/openclaw-config  # openclaw.json + AGENTS.md
└── Secret/openclaw-secrets    # 网关令牌 + API 密钥
```

## 定制

### 代理指令

编辑 `scripts/k8s/manifests/configmap.yaml` 中的 `AGENTS.md` 并重新部署：

```bash
./scripts/k8s/deploy.sh
```

### 网关配置

编辑 `scripts/k8s/manifests/configmap.yaml` 中的 `openclaw.json`。有关完整参考，请参阅 [网关配置](/gateway/configuration)。

### 添加提供商

使用导出的额外密钥重新运行：

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

现有的提供商密钥会留在 Secret 中，除非你覆盖它们。

或者直接补丁 Secret：

```bash
kubectl patch secret openclaw-secrets -n openclaw \
  -p '{"stringData":{"<PROVIDER>_API_KEY":"..."}}'
kubectl rollout restart deployment/openclaw -n openclaw
```

### 自定义命名空间

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh
```

### 自定义镜像

编辑 `scripts/k8s/manifests/deployment.yaml` 中的 `image` 字段：

```yaml
image: ghcr.io/openclaw/openclaw:latest # 或固定到特定版本，来自 https://github.com/openclaw/openclaw/releases
```

### 超越端口转发暴露

默认清单将网关绑定到 pod 内的环回。这适用于 `kubectl port-forward`，但不适用于需要到达 pod IP 的 Kubernetes `Service` 或 Ingress 路径。

如果你想通过 Ingress 或负载均衡器暴露网关：

- 将 `scripts/k8s/manifests/configmap.yaml` 中的网关绑定从 `loopback` 更改为与你的部署模型匹配的非环回绑定
- 保持网关认证启用，并使用适当的 TLS 终止入口点
- 使用支持的网络安全模型配置 Control UI 以进行远程访问（例如 HTTPS/Tailscale Serve 和必要时的显式允许来源）

## 重新部署

```bash
./scripts/k8s/deploy.sh
```

这会应用所有清单并重启 pod 以接收任何配置或密钥更改。

## 拆除

```bash
./scripts/k8s/deploy.sh --delete
```

这会删除命名空间和其中的所有资源，包括 PVC。

## 架构说明

- 网关默认绑定到 pod 内的环回，因此包含的设置适用于 `kubectl port-forward`
- 没有集群范围的资源 —— 所有内容都生活在单个命名空间中
- 安全性：`readOnlyRootFilesystem`、`drop: ALL` 功能、非 root 用户（UID 1000）
- 默认配置将 Control UI 保持在更安全的本地访问路径：环回绑定加上 `kubectl port-forward` 到 `http://127.0.0.1:18789`
- 如果你超越本地主机访问，请使用支持的远程模型：HTTPS/Tailscale 加上适当的网关绑定和 Control UI 来源设置
- 密钥在临时目录中生成并直接应用到集群 —— 没有密钥材料写入到 repo 检出

## 文件结构

```
scripts/k8s/
├── deploy.sh                   # 创建命名空间 + secret，通过 kustomize 部署
├── create-kind.sh              # 本地 Kind 集群（自动检测 docker/podman）
└── manifests/
    ├── kustomization.yaml      # Kustomize 基础
    ├── configmap.yaml          # openclaw.json + AGENTS.md
    ├── deployment.yaml         # 带有安全加固的 Pod 规范
    ├── pvc.yaml                # 10Gi 持久存储
    └── service.yaml            # 18789 上的 ClusterIP
```
