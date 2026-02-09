---
summary: "Tác vụ LLM chỉ JSON cho workflow (công cụ plugin tùy chọn)"
read_when:
  - Bạn muốn một bước LLM chỉ JSON bên trong workflow
  - Bạn cần đầu ra LLM được xác thực theo schema để tự động hóa
title: "Tác vụ LLM"
---

# Tác vụ LLM

`llm-task` là một **công cụ plugin tùy chọn** chạy một tác vụ LLM chỉ JSON và
trả về đầu ra có cấu trúc (có thể tùy chọn xác thực theo JSON Schema).

Cách này rất phù hợp cho các công cụ workflow như Lobster: bạn có thể thêm một bước LLM duy nhất
mà không cần viết mã OpenClaw tùy chỉnh cho từng workflow.

## Bật plugin

1. Bật plugin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. Thêm công cụ vào danh sách cho phép (nó được đăng ký với `optional: true`):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## Cấu hình (tùy chọn)

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` is an allowlist of `provider/model` strings. If set, any request
outside the list is rejected.

## Tham số công cụ

- `prompt` (string, bắt buộc)
- `input` (any, tùy chọn)
- `schema` (object, JSON Schema tùy chọn)
- `provider` (string, tùy chọn)
- `model` (string, tùy chọn)
- `authProfileId` (string, tùy chọn)
- `temperature` (number, tùy chọn)
- `maxTokens` (number, tùy chọn)
- `timeoutMs` (number, tùy chọn)

## Đầu ra

Trả về `details.json` chứa JSON đã được phân tích (và xác thực theo
`schema` khi được cung cấp).

## Ví dụ: bước workflow Lobster

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## Ghi chú an toàn

- Công cụ này **chỉ JSON** và hướng dẫn mô hình chỉ xuất JSON (không
  code fence, không bình luận).
- Không có công cụ nào được cung cấp cho mô hình trong lần chạy này.
- Hãy coi đầu ra là không đáng tin cậy trừ khi bạn xác thực bằng `schema`.
- Đặt các bước phê duyệt trước bất kỳ bước nào gây tác dụng phụ (send, post, exec).
