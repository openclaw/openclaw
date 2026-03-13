---
summary: Use Amazon Bedrock (Converse API) models with OpenClaw
read_when:
  - You want to use Amazon Bedrock models with OpenClaw
  - You need AWS credential/region setup for model calls
title: Amazon Bedrock
---

# Amazon Bedrock

OpenClaw 可以透過 pi‑ai 的 **Bedrock Converse** 串流提供者使用 **Amazon Bedrock** 模型。Bedrock 認證使用 **AWS SDK 預設憑證鏈**，而非 API 金鑰。

## pi‑ai 支援專案

- 提供者：`amazon-bedrock`
- API：`bedrock-converse-stream`
- 認證：AWS 憑證（環境變數、共用設定檔或實例角色）
- 區域：`AWS_REGION` 或 `AWS_DEFAULT_REGION`（預設：`us-east-1`）

## 自動模型偵測

若偵測到 AWS 憑證，OpenClaw 可自動偵測支援 **串流** 與 **文字輸出** 的 Bedrock 模型。偵測使用 `bedrock:ListFoundationModels`，並會快取（預設：1 小時）。

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

注意事項：

- 當存在 AWS 憑證時，`enabled` 預設為 `true`。
- `region` 預設為 `AWS_REGION` 或 `AWS_DEFAULT_REGION`，接著是 `us-east-1`。
- `providerFilter` 對應 Bedrock 提供者名稱（例如 `anthropic`）。
- `refreshInterval` 單位為秒；設定為 `0` 可停用快取。
- `defaultContextWindow`（預設：`32000`）與 `defaultMaxTokens`（預設：`4096`）用於偵測到的模型（若您了解模型限制，可覆寫）。

## 上線流程

1. 確保 **gateway 主機** 上有可用的 AWS 憑證：

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

2. 在您的設定中新增 Bedrock 提供者與模型（不需 `apiKey`）：

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

當在附加了 IAM 角色的 EC2 執行個體上執行 OpenClaw 時，AWS SDK 會自動使用執行個體的元資料服務 (IMDS) 進行驗證。然而，OpenClaw 的憑證偵測目前僅檢查環境變數，並不會檢查 IMDS 憑證。

**解決方法：** 設定 `AWS_PROFILE=default` 以表示 AWS 憑證可用。實際的驗證仍然透過 IMDS 使用執行個體角色。

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

EC2 執行個體角色的 **必要 IAM 權限**：

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels`（用於自動發現）

或附加管理型政策 `AmazonBedrockFullAccess`。

## 快速設定（AWS 路徑）

bash

# 1. 建立 IAM 角色與執行個體設定檔

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

# 3. 在 EC2 執行個體上啟用發現功能

openclaw config set models.bedrockDiscovery.enabled true
openclaw config set models.bedrockDiscovery.region us-east-1

# 4. 設定解決方法的環境變數

echo 'export AWS_PROFILE=default' >> ~/.bashrc
echo 'export AWS_REGION=us-east-1' >> ~/.bashrc
source ~/.bashrc

# 5. 驗證模型是否被發現

openclaw models list

## 注意事項

- Bedrock 需要在您的 AWS 帳號/區域中啟用 **模型存取權限**。
- 自動發現需要 `bedrock:ListFoundationModels` 權限。
- 如果您使用設定檔，請在閘道主機上設定 `AWS_PROFILE`。
- OpenClaw 依序顯示憑證來源：`AWS_BEARER_TOKEN_BEDROCK`，接著是 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`，然後是 `AWS_PROFILE`，最後是預設的 AWS SDK 鏈。
- 推理支援視模型而定；請查看 Bedrock 模型卡以了解目前功能。
- 如果您偏好受管理的金鑰流程，也可以在 Bedrock 前端放置一個相容 OpenAI 的代理，並將其設定為 OpenAI 提供者。
