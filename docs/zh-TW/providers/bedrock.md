---
summary: "使用 Amazon Bedrock（Converse API）模型搭配 OpenClaw"
read_when:
  - 你想要使用 Amazon Bedrock 模型搭配 OpenClaw
  - 你需要為模型呼叫設定 AWS 憑證／區域
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw 可透過 pi‑ai 的 **Bedrock Converse** 串流提供者使用 **Amazon Bedrock** 模型。Bedrock 的身分驗證使用 **AWS SDK 預設憑證鏈**，而非 API 金鑰。 Bedrock auth uses the **AWS SDK default credential chain**,
not an API key.

## pi‑ai 支援項目

- Provider：`amazon-bedrock`
- API：`bedrock-converse-stream`
- Auth：AWS 憑證（環境變數、共享設定或執行個體角色）
- Region：`AWS_REGION` 或 `AWS_DEFAULT_REGION`（預設：`us-east-1`）

## 自動模型探索

若偵測到 AWS 憑證，OpenClaw 可自動探索支援 **串流** 與 **文字輸出** 的 Bedrock 模型。探索使用 `bedrock:ListFoundationModels`，並會快取（預設：1 小時）。 Discovery uses
`bedrock:ListFoundationModels` and is cached (default: 1 hour).

設定選項位於 `models.bedrockDiscovery` 之下：

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

注意事項：

- 當存在 AWS 憑證時，`enabled` 預設為 `true`。
- `region` 預設為 `AWS_REGION` 或 `AWS_DEFAULT_REGION`，接著為 `us-east-1`。
- `providerFilter` 需符合 Bedrock 提供者名稱（例如 `anthropic`）。
- `refreshInterval` 單位為秒；設定為 `0` 可停用快取。
- `defaultContextWindow`（預設：`32000`）與 `defaultMaxTokens`（預設：`4096`）
  會用於探索到的模型（若你知道模型限制，可覆寫）。

## 設定（手動）

1. 確保 **閘道器主機** 上可取得 AWS 憑證：

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

2. 在設定中新增 Bedrock 提供者與模型（不需要 `apiKey`）：

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

## EC2 執行個體角色

當 OpenClaw 執行於已附加 IAM 角色的 EC2 執行個體上時，AWS SDK 會自動使用執行個體中繼資料服務（IMDS）進行身分驗證。然而，OpenClaw 目前的憑證偵測僅檢查環境變數，未檢查 IMDS 憑證。
However, OpenClaw's credential detection currently only checks for environment
variables, not IMDS credentials.

**因應方式：** 設定 `AWS_PROFILE=default` 以表示 AWS 憑證可用。實際的身分驗證仍會透過 IMDS 使用執行個體角色。 The actual authentication still uses the instance role via IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 執行個體角色所需的 **IAM 權限**：

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels`（用於自動探索）

或附加受管政策 `AmazonBedrockFullAccess`。

**快速設定：**

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

- Bedrock 需要在你的 AWS 帳戶／區域中啟用 **模型存取**。
- 自動探索需要 `bedrock:ListFoundationModels` 權限。
- 若你使用設定檔，請在閘道器主機上設定 `AWS_PROFILE`。
- OpenClaw 會依下列順序呈現憑證來源：`AWS_BEARER_TOKEN_BEDROCK`，
  接著 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`，然後 `AWS_PROFILE`，最後為
  AWS SDK 的預設憑證鏈。
- 推理支援取決於模型；請查閱 Bedrock 模型卡以取得最新能力資訊。
- 若你偏好受管金鑰流程，也可在 Bedrock 前方放置相容 OpenAI 的代理，並將其設定為 OpenAI 提供者。
