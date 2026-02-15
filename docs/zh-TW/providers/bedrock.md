---
summary: "使用 OpenClaw 搭配 Amazon Bedrock (Converse API) 模型"
read_when:
  - 您希望將 Amazon Bedrock 模型與 OpenClaw 搭配使用
  - 您需要為模型呼叫設定 AWS 憑證/區域
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw 可以透過 pi‑ai 的 **Bedrock Converse**
區塊串流傳輸供應商使用 **Amazon Bedrock** 模型。Bedrock 憑證使用 **AWS SDK 預設憑證鏈**，
而不是 API 金鑰。

## pi‑ai 支援項目

- 供應商: `amazon-bedrock`
- API: `bedrock-converse-stream`
- 憑證: AWS 憑證 (環境變數、共享設定或執行個體角色)
- 區域: `AWS_REGION` 或 `AWS_DEFAULT_REGION` (預設: `us-east-1`)

## 自動模型裝置探索

如果偵測到 AWS 憑證，OpenClaw 可以自動裝置探索支援**區塊串流傳輸**和**文字輸出**的 Bedrock 模型。裝置探索使用
`bedrock:ListFoundationModels` 並進行快取 (預設: 1 小時)。

設定選項位於 `models.bedrockDiscovery` 下：

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

- 當存在 AWS 憑證時，`enabled` 預設為 `true`。
- `region` 預設為 `AWS_REGION` 或 `AWS_DEFAULT_REGION`，然後是 `us-east-1`。
- `providerFilter` 符合 Bedrock 供應商名稱 (例如 `anthropic`)。
- `refreshInterval` 以秒為單位；設定為 `0` 可停用快取。
- `defaultContextWindow` (預設: `32000`) 和 `defaultMaxTokens` (預設: `4096`)
  用於已裝置探索的模型 (如果您知道模型限制，請覆寫)。

## 設定 (手動)

1. 確保 AWS 憑證在 **Gateway 主機**上可用:

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

2. 將 Bedrock 供應商和模型新增至您的設定 (無需 `apiKey`):

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

在附有 IAM 角色 的 EC2 執行個體上執行 OpenClaw 時，AWS SDK 將自動使用執行個體中繼資料服務 (IMDS) 進行身分驗證。
然而，OpenClaw 目前的憑證偵測僅檢查環境變數，而非 IMDS 憑證。

**解決方法:** 設定 `AWS_PROFILE=default` 以表示 AWS 憑證可用。實際的身分驗證仍透過 IMDS 使用執行個體角色。

```bash
# 加入 ~/.bashrc 或您的 shell 設定檔
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 執行個體角色所需的 **IAM 權限**:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (用於自動裝置探索)

或者附加受管政策 `AmazonBedrockFullAccess`。

**快速設定:**

```bash
# 1. 建立 IAM 角色和執行個體設定檔
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

# 2. 附加至您的 EC2 執行個體
aws ec2 associate-iam-instance-profile \
  --instance-id i-xxxxx \
  --iam-instance-profile Name=EC2-Bedrock-Access

# 3. 在 EC2 執行個體上，啟用裝置探索
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. 設定解決方法環境變數
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. 驗證模型是否已裝置探索
openclaw models list
```

## 注意事項

- Bedrock 需要在您的 AWS 帳戶/區域中啟用**模型存取權**。
- 自動裝置探索需要 `bedrock:ListFoundationModels` 權限。
- 如果您使用設定檔，請在 Gateway 主機上設定 `AWS_PROFILE`。
- OpenClaw 憑證來源的優先順序為: `AWS_BEARER_TOKEN_BEDROCK`，
  然後是 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`，然後是 `AWS_PROFILE`，然後是
  預設的 AWS SDK 鏈。
- 推理支援取決於模型；請查閱 Bedrock 模型卡以了解當前功能。
- 如果您偏好受管理的金鑰流程，也可以在 Bedrock 前面放置一個 OpenAI 相容的代理，並將其設定為 OpenAI 供應商。
