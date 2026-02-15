---
summary: "在 OpenClaw 中使用 Amazon Bedrock (Converse API) 模型"
read_when:
  - 您想在 OpenClaw 中使用 Amazon Bedrock 模型
  - 您需要為模型呼叫設定 AWS 憑證/區域
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw 可以透過 Pi 提供的 **Bedrock Converse** 串流供應商使用 **Amazon Bedrock** 模型。Bedrock 驗證使用的是 **AWS SDK 預設憑證鏈**，而不是 API 金鑰。

## Pi 支援的項目

- 供應商：`amazon-bedrock`
- API：`bedrock-converse-stream`
- 驗證：AWS 憑證（環境變數、共用設定或執行個體角色）
- 區域：`AWS_REGION` 或 `AWS_DEFAULT_REGION`（預設：`us-east-1`）

## 自動模型探索

如果偵測到 AWS 憑證，OpenClaw 可以自動探索支援 **串流** 與 **文字輸出** 的 Bedrock 模型。裝置探索功能使用 `bedrock:ListFoundationModels` 並會進行快取（預設：1 小時）。

設定選項位於 `models.bedrockDiscovery`：

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

備註：

- 當 AWS 憑證存在時，`enabled` 預設為 `true`。
- `region` 預設為 `AWS_REGION` 或 `AWS_DEFAULT_REGION`，若皆未設定則為 `us-east-1`。
- `providerFilter` 符合 Bedrock 供應商名稱（例如 `anthropic`）。
- `refreshInterval` 單位為秒；設為 `0` 可停用快取。
- 探索到的模型會使用 `defaultContextWindow`（預設：`32000`）和 `defaultMaxTokens`（預設：`4096`）（如果您知道您的模型限制，可以進行覆寫）。

## 設定（手動）

1. 確保 **Gateway 主機**上可使用 AWS 憑證：

```bash
export AWS_ACCESS_KEY_ID="AKIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"
# 選填：
export AWS_SESSION_TOKEN="..."
export AWS_PROFILE="your-profile"
# 選填（Bedrock API 金鑰/持有人代標記）：
export AWS_BEARER_TOKEN_BEDROCK="..."
```

2. 在您的設定檔案中新增 Bedrock 供應商與模型（不需 `apiKey`）：

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

當在連接了 IAM 角色的 EC2 執行個體上執行 OpenClaw 時，AWS SDK 會自動使用執行個體中繼資料服務 (IMDS) 進行驗證。然而，OpenClaw 目前的憑證偵測僅檢查環境變數，而非 IMDS 憑證。

**暫時解決方案：** 設定 `AWS_PROFILE=default` 以標示 AWS 憑證可用。實際驗證仍會透過 IMDS 使用執行個體角色。

```bash
# 新增至 ~/.bashrc 或您的 shell 設定檔
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 執行個體角色所需的 **IAM 許可**：

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (用於自動探索)

或連接受管政策 `AmazonBedrockFullAccess`。

**快速設定：**

```bash
# 1. 建立 IAM 角色與執行個體描述檔 (instance profile)
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

# 2. 連接至您的 EC2 執行個體
aws ec2 associate-iam-instance-profile \
  --instance-id i-xxxxx \
  --iam-instance-profile Name=EC2-Bedrock-Access

# 3. 在 EC2 執行個體上啟用自動探索
openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. 設定暫時解決方案的環境變數
echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. 驗證模型是否已被探索到
openclaw models list
```

## 注意事項

- Bedrock 需要在您的 AWS 帳號/區域中啟用 **模型存取 (model access)**。
- 自動探索需要 `bedrock:ListFoundationModels` 許可。
- 如果您使用 profile，請在 Gateway 主機上設定 `AWS_PROFILE`。
- OpenClaw 會依以下順序取得憑證來源：`AWS_BEARER_TOKEN_BEDROCK`，接著是 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`，然後是 `AWS_PROFILE`，最後是預設的 AWS SDK 鏈。
- 推理 (Reasoning) 支援取決於模型；請查看 Bedrock 模型卡以瞭解目前功能。
- 如果您偏好受管金鑰流程，也可以在 Bedrock 前方放置一個與 OpenAI 相容的代理伺服器，並將其設定為 OpenAI 供應商。
