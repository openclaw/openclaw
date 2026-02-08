---
summary: "Áp dụng các bản vá nhiều tệp bằng công cụ apply_patch"
read_when:
  - Bạn cần chỉnh sửa tệp có cấu trúc trên nhiều tệp
  - Bạn muốn ghi lại tài liệu hoặc gỡ lỗi các chỉnh sửa dựa trên bản vá
title: "Công cụ apply_patch"
x-i18n:
  source_path: tools/apply-patch.md
  source_hash: 8cec2b4ee3afa910
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:15Z
---

# công cụ apply_patch

Áp dụng thay đổi tệp bằng định dạng bản vá có cấu trúc. Cách này lý tưởng cho các chỉnh sửa
nhiều tệp hoặc nhiều hunk, nơi một lệnh gọi `edit` duy nhất sẽ dễ bị lỗi.

Công cụ chấp nhận một chuỗi `input` duy nhất, bao bọc một hoặc nhiều thao tác trên tệp:

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## Tham số

- `input` (bắt buộc): Toàn bộ nội dung bản vá, bao gồm `*** Begin Patch` và `*** End Patch`.

## Ghi chú

- Đường dẫn được phân giải tương đối so với thư mục gốc của workspace.
- Dùng `*** Move to:` trong một hunk `*** Update File:` để đổi tên tệp.
- `*** End of File` đánh dấu chèn chỉ-EOF khi cần.
- Thử nghiệm và bị tắt theo mặc định. Bật bằng `tools.exec.applyPatch.enabled`.
- Chỉ dành cho OpenAI (bao gồm OpenAI Codex). Có thể tùy chọn kiểm soát theo mô hình qua
  `tools.exec.applyPatch.allowModels`.
- Cấu hình chỉ nằm dưới `tools.exec`.

## Ví dụ

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
