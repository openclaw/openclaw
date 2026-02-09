---
summary: "Sử dụng các mô hình Amazon Bedrock (Converse API) với OpenClaw"
read_when:
  - Bạn muốn sử dụng các mô hình Amazon Bedrock với OpenClaw
  - Bạn cần thiết lập thông tin xác thực/khu vực AWS cho các lệnh gọi mô hình
title: "Amazon Bedrock"
---

# Amazon Bedrock

OpenClaw có thể sử dụng các mô hình **Amazon Bedrock** thông qua nhà cung cấp streaming **Bedrock Converse** của pi‑ai. Xác thực Bedrock sử dụng **chuỗi thông tin xác thực mặc định của AWS SDK**,
không phải khóa API.

## Những gì pi‑ai hỗ trợ

- Nhà cung cấp: `amazon-bedrock`
- API: `bedrock-converse-stream`
- Xác thực: thông tin xác thực AWS (biến môi trường, cấu hình dùng chung, hoặc vai trò instance)
- Khu vực: `AWS_REGION` hoặc `AWS_DEFAULT_REGION` (mặc định: `us-east-1`)

## Tự động khám phá mô hình

Nếu phát hiện thông tin xác thực AWS, OpenClaw có thể tự động khám phá các mô hình Bedrock hỗ trợ **streaming** và **xuất văn bản**. Việc khám phá sử dụng
`bedrock:ListFoundationModels` và được lưu bộ đệm (mặc định: 1 giờ).

Các tùy chọn cấu hình nằm dưới `models.bedrockDiscovery`:

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

Ghi chú:

- `enabled` mặc định là `true` khi có thông tin xác thực AWS.
- `region` mặc định là `AWS_REGION` hoặc `AWS_DEFAULT_REGION`, sau đó là `us-east-1`.
- `providerFilter` khớp với tên nhà cung cấp Bedrock (ví dụ `anthropic`).
- `refreshInterval` tính bằng giây; đặt thành `0` để tắt bộ nhớ đệm.
- `defaultContextWindow` (mặc định: `32000`) và `defaultMaxTokens` (mặc định: `4096`)
  được dùng cho các mô hình được khám phá (ghi đè nếu bạn biết giới hạn của mô hình).

## Thiết lập (thủ công)

1. Đảm bảo thông tin xác thực AWS có sẵn trên **máy chủ gateway**:

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

2. Thêm một nhà cung cấp Bedrock và mô hình vào cấu hình của bạn (không cần `apiKey`):

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

## Vai trò EC2 Instance

When running OpenClaw on an EC2 instance with an IAM role attached, the AWS SDK
will automatically use the instance metadata service (IMDS) for authentication.
Tuy nhiên, việc phát hiện thông tin xác thực của OpenClaw hiện chỉ kiểm tra các biến môi trường,
không kiểm tra thông tin xác thực IMDS.

**Cách khắc phục:** Đặt `AWS_PROFILE=default` để báo hiệu rằng thông tin xác thực AWS khả dụng. Xác thực thực tế vẫn sử dụng vai trò instance thông qua IMDS.

```bash
# Add to ~/.bashrc or your shell profile
export AWS_PROFILE=default
export AWS_REGION=us-east-1
```

**Quyền IAM bắt buộc** cho vai trò EC2 instance:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `bedrock:ListFoundationModels` (cho tự động khám phá)

Hoặc gắn chính sách được quản lý `AmazonBedrockFullAccess`.

**Thiết lập nhanh:**

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

## Ghi chú

- Bedrock yêu cầu bật **quyền truy cập mô hình** trong tài khoản/khu vực AWS của bạn.
- Tự động khám phá cần quyền `bedrock:ListFoundationModels`.
- Nếu bạn dùng profile, hãy đặt `AWS_PROFILE` trên máy chủ gateway.
- OpenClaw hiển thị nguồn thông tin xác thực theo thứ tự sau: `AWS_BEARER_TOKEN_BEDROCK`,
  sau đó `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, rồi `AWS_PROFILE`, cuối cùng là
  chuỗi mặc định của AWS SDK.
- Hỗ trợ reasoning phụ thuộc vào mô hình; hãy kiểm tra thẻ mô hình Bedrock để biết
  khả năng hiện tại.
- Nếu bạn предпоч thích một luồng khóa được quản lý, bạn cũng có thể đặt một proxy
  tương thích OpenAI phía trước Bedrock và cấu hình nó như một nhà cung cấp OpenAI
  thay thế.
