---
read_when:
    - KubernetesクラスターでOpenClawを実行したい場合
    - Kubernetes環境でOpenClawをテストしたい場合
summary: KustomizeでOpenClaw Gateway ゲートウェイをKubernetesクラスターにデプロイする
title: Kubernetes
x-i18n:
    generated_at: "2026-04-02T08:33:52Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 968fa9bd4cf31da9d50b96ac8dadea024a8a340f640e42274be67a54a6c80537
    source_path: install/kubernetes.md
    workflow: 15
---

# OpenClaw on Kubernetes

KubernetesでOpenClawを実行するための最小限の出発点です。本番環境向けのデプロイではありません。コアリソースをカバーしており、お使いの環境に合わせて適応することを想定しています。

## なぜHelmではないのか？

OpenClawはいくつかの設定ファイルを持つ単一のコンテナです。興味深いカスタマイズはインフラストラクチャのテンプレート化ではなく、エージェントのコンテンツ（マークダウンファイル、Skills、設定のオーバーライド）にあります。KustomizeはHelmチャートのオーバーヘッドなしにオーバーレイを処理できます。デプロイがより複雑になった場合、これらのマニフェストの上にHelmチャートを追加できます。

## 必要なもの

- 稼働中のKubernetesクラスター（AKS、EKS、GKE、k3s、kind、OpenShiftなど）
- クラスターに接続された `kubectl`
- 少なくとも1つのモデルプロバイダーのAPIキー

## クイックスタート

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh

kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

Gateway ゲートウェイトークンを取得してコントロールUIに貼り付けます:

```bash
kubectl get secret openclaw-secrets -n openclaw -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d
```

ローカルデバッグの場合、`./scripts/k8s/deploy.sh --show-token` でデプロイ後にトークンが表示されます。

## Kindによるローカルテスト

クラスターがない場合は、[Kind](https://kind.sigs.k8s.io/)でローカルに作成できます:

```bash
./scripts/k8s/create-kind.sh           # auto-detects docker or podman
./scripts/k8s/create-kind.sh --delete  # tear down
```

その後、通常通り `./scripts/k8s/deploy.sh` でデプロイします。

## ステップバイステップ

### 1) デプロイ

**オプションA** — 環境変数にAPIキーを設定（ワンステップ）:

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh
```

スクリプトはAPIキーと自動生成されたGateway ゲートウェイトークンを含むKubernetes Secretを作成し、デプロイします。Secretが既に存在する場合は、現在のGateway ゲートウェイトークンと変更されていないプロバイダーキーを保持します。

**オプションB** — Secretを個別に作成:

```bash
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

ローカルテスト用にトークンをstdoutに出力したい場合は、いずれかのコマンドで `--show-token` を使用してください。

### 2) Gateway ゲートウェイへのアクセス

```bash
kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://localhost:18789
```

## デプロイされるもの

```
Namespace: openclaw (configurable via OPENCLAW_NAMESPACE)
├── Deployment/openclaw        # Single pod, init container + gateway
├── Service/openclaw           # ClusterIP on port 18789
├── PersistentVolumeClaim      # 10Gi for agent state and config
├── ConfigMap/openclaw-config  # openclaw.json + AGENTS.md
└── Secret/openclaw-secrets    # Gateway token + API keys
```

## カスタマイズ

### エージェントの指示

`scripts/k8s/manifests/configmap.yaml` の `AGENTS.md` を編集して再デプロイします:

```bash
./scripts/k8s/deploy.sh
```

### Gateway ゲートウェイの設定

`scripts/k8s/manifests/configmap.yaml` の `openclaw.json` を編集してください。完全なリファレンスは[Gateway ゲートウェイの設定](/gateway/configuration)を参照してください。

### プロバイダーの追加

追加のキーをエクスポートして再実行します:

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

既存のプロバイダーキーは上書きしない限りSecretに残ります。

またはSecretを直接パッチします:

```bash
kubectl patch secret openclaw-secrets -n openclaw \
  -p '{"stringData":{"<PROVIDER>_API_KEY":"..."}}'
kubectl rollout restart deployment/openclaw -n openclaw
```

### カスタム名前空間

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh
```

### カスタムイメージ

`scripts/k8s/manifests/deployment.yaml` の `image` フィールドを編集します:

```yaml
image: ghcr.io/openclaw/openclaw:latest # or pin to a specific version from https://github.com/openclaw/openclaw/releases
```

### port-forward以外での公開

デフォルトのマニフェストではGateway ゲートウェイをPod内でloopbackにバインドします。これは `kubectl port-forward` で動作しますが、Pod IPに到達する必要があるKubernetesの `Service` やIngressパスでは動作しません。

IngressやロードバランサーでGateway ゲートウェイを公開したい場合:

- `scripts/k8s/manifests/configmap.yaml` のGateway ゲートウェイバインドを `loopback` からデプロイモデルに合った非loopbackバインドに変更してください
- Gateway ゲートウェイ認証を有効にしたまま、適切なTLS終端エントリーポイントを使用してください
- サポートされているWebセキュリティモデル（例: HTTPS/Tailscale Serveおよび必要に応じて明示的な許可オリジン）を使用して、コントロールUIをリモートアクセス用に設定してください

## 再デプロイ

```bash
./scripts/k8s/deploy.sh
```

これはすべてのマニフェストを適用し、設定やSecretの変更を反映するためにPodを再起動します。

## 削除

```bash
./scripts/k8s/deploy.sh --delete
```

これはPVCを含む名前空間とそのすべてのリソースを削除します。

## アーキテクチャに関する注意

- Gateway ゲートウェイはデフォルトでPod内のloopbackにバインドするため、付属のセットアップは `kubectl port-forward` 用です
- クラスタースコープのリソースはありません — すべてが単一の名前空間に存在します
- セキュリティ: `readOnlyRootFilesystem`、`drop: ALL` capabilities、非rootユーザー（UID 1000）
- デフォルト設定はコントロールUIをより安全なローカルアクセスパスに維持します: loopbackバインド + `kubectl port-forward` で `http://127.0.0.1:18789` にアクセス
- localhostアクセスを超える場合は、サポートされているリモートモデル（HTTPS/Tailscale + 適切なGateway ゲートウェイバインドおよびコントロールUIのオリジン設定）を使用してください
- Secretは一時ディレクトリで生成されクラスターに直接適用されます — シークレットの内容がリポジトリのチェックアウトに書き込まれることはありません

## ファイル構造

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
