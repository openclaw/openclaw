---
summary: "Áp dụng các bản vá nhiều tệp bằng công cụ apply_patch"
read_when:
  - Bạn cần chỉnh sửa tệp có cấu trúc trên nhiều tệp
  - Bạn muốn ghi lại tài liệu hoặc gỡ lỗi các chỉnh sửa dựa trên bản vá
title: "Công cụ apply_patch"
---

# công cụ apply_patch

Apply file changes using a structured patch format. This is ideal for multi-file
or multi-hunk edits where a single `edit` call would be brittle.

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
- Experimental and disabled by default. Enable with `tools.exec.applyPatch.enabled`.
- OpenAI-only (including OpenAI Codex). Optionally gate by model via
  `tools.exec.applyPatch.allowModels`.
- Cấu hình chỉ nằm dưới `tools.exec`.

## Ví dụ

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```
