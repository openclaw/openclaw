---
summary: "OpenClaw で Amazon Bedrock（Converse API）モデルを使用します"
read_when:
  - OpenClaw で Amazon Bedrock モデルを使用したい場合
  - モデル呼び出しのために AWS の認証情報／リージョン設定が必要な場合
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw は、pi‑ai の **Bedrock Converse** ストリーミングプロバイダーを介して **Amazon Bedrock** モデルを使用できます。Bedrock の認証は **AWS SDK のデフォルト認証情報チェーン** を使用し、API キーは使用しません。 5. Bedrock の認証は **AWS SDK のデフォルト認証情報チェーン** を使用し、
API キーは使用しません。

## pi‑ai がサポートする内容

- プロバイダー: `amazon-bedrock`
- API: `bedrock-converse-stream`
- 認証: AWS 認証情報（環境変数、共有設定、またはインスタンスロール）
- リージョン: `AWS_REGION` または `AWS_DEFAULT_REGION`（デフォルト: `us-east-1`）

## 自動モデル検出

AWS 認証情報が検出されると、OpenClaw は **ストリーミング** と **テキスト出力** をサポートする Bedrock モデルを自動的に検出できます。検出には `bedrock:ListFoundationModels` を使用し、結果はキャッシュされます（デフォルト: 1 時間）。 ディスカバリーは
`bedrock:ListFoundationModels` を使用してキャッシュされます(デフォルト: 1時間)。

設定オプションは `models.bedrockDiscovery` 配下にあります。

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

注記:

- `enabled` は、AWS 認証情報が存在する場合に `true` がデフォルトになります。
- `region` は、`AWS_REGION` または `AWS_DEFAULT_REGION`、次に `us-east-1` がデフォルトになります。
- `providerFilter` は Bedrock のプロバイダー名に一致します（例: `anthropic`）。
- `refreshInterval` は秒です。キャッシュを無効にするには `0` に設定します。
- `defaultContextWindow`（デフォルト: `32000`）および `defaultMaxTokens`（デフォルト: `4096`）
  は検出されたモデルに使用されます（モデルの上限が分かっている場合は上書きしてください）。

## セットアップ（手動）

1. **ゲートウェイ ホスト** で AWS 認証情報が利用可能であることを確認します。

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

2. 設定に Bedrock プロバイダーとモデルを追加します（`apiKey` は不要です）。

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

IAM ロールを関連付けた EC2 インスタンスで OpenClaw を実行する場合、AWS SDK は認証のためにインスタンスメタデータサービス（IMDS）を自動的に使用します。ただし、OpenClaw の認証情報検出は現在、環境変数のみを確認し、IMDS の認証情報は確認しません。
しかし、OpenClawの資格情報検出は現在、IMDSの資格情報ではなく、環境
変数のみをチェックしています。

**回避策:** AWS 認証情報が利用可能であることを示すために `AWS_PROFILE=default` を設定します。実際の認証は引き続き IMDS 経由のインスタンスロールを使用します。 実際の認証はIMDS経由でインスタンスロールを使用します。

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 インスタンスロールに必要な **IAM 権限**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels`（自動検出用）

または、管理ポリシー `AmazonBedrockFullAccess` をアタッチしてください。

**クイックセットアップ:**

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

## 注記

- Bedrock では、AWS アカウント／リージョンで **モデルアクセス** を有効にする必要があります。
- 自動検出には `bedrock:ListFoundationModels` の権限が必要です。
- プロファイルを使用する場合は、ゲートウェイ ホストで `AWS_PROFILE` を設定してください。
- OpenClaw は、認証情報の取得元を次の順序で表示します: `AWS_BEARER_TOKEN_BEDROCK`、
  次に `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`、次に `AWS_PROFILE`、最後に
  AWS SDK のデフォルトチェーンです。
- 推論（Reasoning）のサポートはモデルに依存します。最新の機能については Bedrock のモデルカードを確認してください。
- 管理されたキーのフローを希望する場合は、Bedrock の前段に OpenAI 互換プロキシを配置し、代わりに OpenAI プロバイダーとして設定することもできます。
