---
read_when:
    - Amazon Bedrock モデルを OpenClaw で使用したい場合
    - モデル呼び出しに必要な AWS 認証情報/リージョンの設定が必要な場合
summary: Amazon Bedrock（Converse API）モデルを OpenClaw で使用する
title: Amazon Bedrock
x-i18n:
    generated_at: "2026-04-02T08:37:42Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: d50d0dcd7154d6273f3250883878e8d882e6fd4780830637e1b97fa7c1d3a22a
    source_path: providers/bedrock.md
    workflow: 15
---

# Amazon Bedrock

OpenClaw は pi‑ai の **Bedrock Converse** ストリーミングプロバイダーを通じて **Amazon Bedrock** モデルを使用できます。Bedrock の認証は API キーではなく、**AWS SDK のデフォルト認証チェーン**を使用します。

## pi-ai がサポートする内容

- プロバイダー: `amazon-bedrock`
- API: `bedrock-converse-stream`
- 認証: AWS 認証情報（環境変数、共有設定、またはインスタンスロール）
- リージョン: `AWS_REGION` または `AWS_DEFAULT_REGION`（デフォルト: `us-east-1`）

## 自動モデルディスカバリー

AWS 認証情報が検出された場合、OpenClaw は**ストリーミング**と**テキスト出力**をサポートする Bedrock モデルを自動的に検出できます。ディスカバリーは `bedrock:ListFoundationModels` を使用し、キャッシュされます（デフォルト: 1時間）。

設定オプションは `models.bedrockDiscovery` 配下にあります:

```json5
{
  models: {
    bedrockDiscovery: {
      enabled: true,
      region: "us-east-1",
      providerFilter: ["anthropic", "amazon"],
      refreshInterval: 3600,
      defaultContextWindow: 32000,
      defaultMaxTokens: 4096,
    },
  },
}
```

注意事項:

- `enabled` は AWS 認証情報が存在する場合、デフォルトで `true` になります。
- `region` は `AWS_REGION` または `AWS_DEFAULT_REGION` がデフォルトで、次に `us-east-1` になります。
- `providerFilter` は Bedrock プロバイダー名にマッチします（例: `anthropic`）。
- `refreshInterval` は秒単位です。`0` に設定するとキャッシュが無効になります。
- `defaultContextWindow`（デフォルト: `32000`）と `defaultMaxTokens`（デフォルト: `4096`）は検出されたモデルに使用されます（モデルの制限がわかっている場合はオーバーライドしてください）。

## オンボーディング

1. **Gateway ゲートウェイホスト**で AWS 認証情報が利用可能であることを確認します:

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
# Optional:
export AWS_SESSION_TOKEN="..."
export AWS_PROFILE="your-profile"
# Optional (Bedrock API key/bearer token):
export AWS_BEARER_TOKEN_BEDROCK="..."
```

2. 設定に Bedrock プロバイダーとモデルを追加します（`apiKey` は不要です）:

```json5
{
  models: {
    providers: {
      "amazon-bedrock": {
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        models: [
          {
            id: "us.anthropic.claude-opus-4-6-v1:0",
            name: "Claude Opus 4.6 (Bedrock)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0" },
    },
  },
}
```

## EC2 インスタンスロール

IAM ロールがアタッチされた EC2 インスタンスで OpenClaw を実行する場合、AWS SDK はインスタンスメタデータサービス（IMDS）を使用して自動的に認証します。ただし、OpenClaw の認証情報検出は現在、環境変数のみをチェックし、IMDS 認証情報はチェックしません。

**回避策:** `AWS_PROFILE=default` を設定して、AWS 認証情報が利用可能であることを示します。実際の認証は引き続き IMDS 経由のインスタンスロールを使用します。

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 インスタンスロールに**必要な IAM 権限**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels`（自動ディスカバリー用）

または、マネージドポリシー `AmazonBedrockFullAccess` をアタッチしてください。

## クイックセットアップ（AWS パス）

```bash
# 1. Create IAM role and instance profile
aws iam create-role --role-name EC2-Bedrock-Access \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy --role-name EC2-Bedrock-Access \
  --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess

aws iam create-instance-profile --instance-profile-name EC2-Bedrock-Access
aws iam add-role-to-instance-profile \
  --instance-profile-name EC2-Bedrock-Access \
  --role-name EC2-Bedrock-Access

# 2. Attach to your EC2 instance
aws ec2 associate-iam-instance-profile \
  --instance-id i-xxxxx \
  --iam-instance-profile Name=EC2-Bedrock-Access

# 3. On the EC2 instance, enable discovery
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. Set the workaround env vars
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. Verify models are discovered
openclaw models list
```

## 注意事項

- Bedrock は AWS アカウント/リージョンで**モデルアクセス**が有効になっている必要があります。
- 自動ディスカバリーには `bedrock:ListFoundationModels` 権限が必要です。
- プロファイルを使用する場合は、Gateway ゲートウェイホストで `AWS_PROFILE` を設定してください。
- OpenClaw は以下の順序で認証情報ソースを解決します: `AWS_BEARER_TOKEN_BEDROCK`、次に `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`、次に `AWS_PROFILE`、最後にデフォルトの AWS SDK チェーン。
- 推論サポートはモデルに依存します。現在の機能については Bedrock モデルカードを確認してください。
- マネージドキーフローを好む場合は、Bedrock の前に OpenAI 互換プロキシを配置し、OpenAI プロバイダーとして設定することもできます。

## ガードレール

`amazon-bedrock` プラグイン設定に `guardrail` オブジェクトを追加することで、すべての Bedrock モデル呼び出しに [Amazon Bedrock ガードレール](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)を適用できます。ガードレールを使用すると、コンテンツフィルタリング、トピック拒否、ワードフィルター、機密情報フィルター、およびコンテキストグラウンディングチェックを適用できます。

```json5
{
  plugins: {
    entries: {
      "amazon-bedrock": {
        config: {
          guardrail: {
            guardrailIdentifier: "abc123", // guardrail ID or full ARN
            guardrailVersion: "1", // version number or "DRAFT"
            streamProcessingMode: "sync", // optional: "sync" or "async"
            trace: "enabled", // optional: "enabled", "disabled", or "enabled_full"
          },
        },
      },
    },
  },
}
```

- `guardrailIdentifier`（必須）はガードレール ID（例: `abc123`）またはフル ARN（例: `arn:aws:bedrock:us-east-1:123456789012:guardrail/abc123`）を受け付けます。
- `guardrailVersion`（必須）は使用する公開バージョンを指定するか、作業中のドラフトには `"DRAFT"` を指定します。
- `streamProcessingMode`（省略可能）はストリーミング中にガードレール評価を同期的（`"sync"`）に実行するか非同期的（`"async"`）に実行するかを制御します。省略した場合、Bedrock はデフォルトの動作を使用します。
- `trace`（省略可能）は API レスポンスにガードレールのトレース出力を有効にします。デバッグには `"enabled"` または `"enabled_full"` を設定し、本番環境では省略するか `"disabled"` を設定してください。

Gateway ゲートウェイが使用する IAM プリンシパルには、標準の呼び出し権限に加えて `bedrock:ApplyGuardrail` 権限が必要です。
