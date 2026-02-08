---
summary: "Ghi chú giao thức RPC cho trình hướng dẫn onboarding và lược đồ cấu hình"
read_when: "Khi thay đổi các bước của trình hướng dẫn onboarding hoặc các endpoint lược đồ cấu hình"
title: "Giao thức Onboarding và Cấu hình"
x-i18n:
  source_path: experiments/onboarding-config-protocol.md
  source_hash: 55163b3ee029c024
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:47Z
---

# Giao thức Onboarding + Cấu hình

Mục đích: các bề mặt onboarding + cấu hình dùng chung trên CLI, ứng dụng macOS và Web UI.

## Thành phần

- Công cụ wizard (phiên dùng chung + lời nhắc + trạng thái onboarding).
- Onboarding trên CLI sử dụng cùng luồng wizard như các client UI.
- RPC của Gateway cung cấp các endpoint wizard + lược đồ cấu hình.
- Onboarding trên macOS sử dụng mô hình bước của wizard.
- Web UI hiển thị biểu mẫu cấu hình từ JSON Schema + gợi ý UI.

## RPC của Gateway

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Phản hồi (hình dạng)

- Wizard: `{ sessionId, done, step?, status?, error? }`
- Lược đồ cấu hình: `{ schema, uiHints, version, generatedAt }`

## Gợi ý UI

- `uiHints` được khóa theo đường dẫn; metadata tùy chọn (label/help/group/order/advanced/sensitive/placeholder).
- Các trường nhạy cảm hiển thị dưới dạng input mật khẩu; không có lớp che/redaction.
- Các node lược đồ không được hỗ trợ sẽ quay về trình chỉnh sửa JSON thô.

## Ghi chú

- Tài liệu này là nơi duy nhất để theo dõi các thay đổi refactor giao thức cho onboarding/cấu hình.
