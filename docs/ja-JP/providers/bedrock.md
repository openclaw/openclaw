---
summary: "Amazon Bedrock（Converse API）モデルをOpenClawで使用する"
read_when:
  - OpenClawでAmazon Bedrockモデルを使いたい場合
  - モデル呼び出しのためのAWSクレデンシャル/リージョン設定が必要な場合
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClawはpi-aiの**Bedrock Converse**ストリーミングプロバイダーを通じて**Amazon Bedrock**モデルを使用できます。BedrockはAPIキーではなく**AWSSDKデフォルトクレデンシャルチェーン**を使用して認証します。

## pi-aiがサポートするもの

- プロバイダー: `amazon-bedrock`
- API: `bedrock-converse-stream`
- 認証: AWSクレデンシャル（環境変数、共有設定、またはインスタンスロール）
- リージョン: `AWS_REGION` または `AWS_DEFAULT_REGION`（デフォルト: `us-east-1`）

## 自動モデル検出

AWSクレデンシャルが検出されると、OpenClawは**ストリーミング**と**テキスト出力**をサポートするBedrockモデルを自動的に検出できます。検出には `bedrock:ListFoundationModels` を使用し、結果はキャッシュされます（デフォルト: 1時間）。

設定オプションは `models.bedrockDiscovery` 以下にあります:

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

- `enabled` はAWSクレデンシャルが存在する場合に `true` がデフォルトです。
- `region` はデフォルトで `AWS_REGION` または `AWS_DEFAULT_REGION`、次に `us-east-1` になります。
- `providerFilter` はBedrockプロバイダー名（例: `anthropic`）にマッチします。
- `refreshInterval` は秒単位です。`0` に設定するとキャッシングが無効になります。
- `defaultContextWindow`（デフォルト: `32000`）および `defaultMaxTokens`（デフォルト: `4096`）は検出されたモデルに使用されます（モデルの制限がわかっている場合はオーバーライドしてください）。

## オンボーディング

1. **Gatewayホスト**でAWSクレデンシャルが利用可能であることを確認してください:

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
# オプション:
export AWS_SESSION_TOKEN="..."
export AWS_PROFILE="your-profile"
# オプション（Bedrock APIキー/Bearerトークン）:
export AWS_BEARER_TOKEN_BEDROCK="..."
```

2. Bedrockプロバイダーとモデルを設定に追加します（`apiKey` は不要）:

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

## EC2インスタンスロール

IAMロールが付与されたEC2インスタンス上でOpenClawを実行する場合、AWS SDKは認証のためにインスタンスメタデータサービス（IMDS）を自動的に使用します。ただし、OpenClawのクレデンシャル検出は現在、環境変数のみをチェックし、IMDSクレデンシャルはチェックしません。

**回避策:** `AWS_PROFILE=default` を設定してAWSクレデンシャルが利用可能であることを示します。実際の認証はIMDSを通じたインスタンスロールを引き続き使用します。

```bash
# ~/.bashrc またはシェルプロファイルに追加
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2インスタンスロールに**必要なIAMパーミッション**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels`（自動検出用）

または、管理ポリシー `AmazonBedrockFullAccess` をアタッチしてください。

## クイックセットアップ（AWSパス）

```bash
# 1. IAMロールとインスタンスプロファイルを作成する
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

# 2. EC2インスタンスにアタッチする
aws ec2 associate-iam-instance-profile \
  --instance-id i-xxxxx \
  --iam-instance-profile Name=EC2-Bedrock-Access

# 3. EC2インスタンス上で検出を有効にする
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. 回避策の環境変数を設定する
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. モデルが検出されているか確認する
openclaw models list
```

## 注意事項

- BedrockはAWSアカウント/リージョンで**モデルアクセス**が有効になっている必要があります。
- 自動検出には `bedrock:ListFoundationModels` パーミッションが必要です。
- プロファイルを使用する場合は、Gatewayホストで `AWS_PROFILE` を設定してください。
- OpenClawはクレデンシャルソースを次の順序で検索します: `AWS_BEARER_TOKEN_BEDROCK`、次に `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`、次に `AWS_PROFILE`、次にデフォルトのAWS SDKチェーン。
- 推論サポートはモデルに依存します。現在の機能についてはBedrockモデルカードを確認してください。
- 管理されたキーフローを優先する場合は、Bedrockの前にOpenAI互換プロキシを配置してOpenAIプロバイダーとして設定することもできます。
