---
summary: "Tham chiếu CLI cho `openclaw memory` (status/index/search)"
read_when:
  - Bạn muốn lập chỉ mục hoặc tìm kiếm bộ nhớ ngữ nghĩa
  - Bạn đang gỡ lỗi khả năng sẵn sàng hoặc việc lập chỉ mục bộ nhớ
title: "bộ nhớ"
---

# `openclaw memory`

Quản lý việc lập chỉ mục và tìm kiếm bộ nhớ ngữ nghĩa.
Được cung cấp bởi plugin bộ nhớ đang hoạt động (mặc định: `memory-core`; đặt `plugins.slots.memory = "none"` để tắt).

Liên quan:

- Khái niệm bộ nhớ: [Memory](/concepts/memory)
- Plugin: [Plugins](/tools/plugin)

## Ví dụ

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Tùy chọn

Chung:

- `--agent <id>`: giới hạn phạm vi cho một tác tử (mặc định: tất cả các tác tử đã cấu hình).
- `--verbose`: xuất log chi tiết trong quá trình thăm dò và lập chỉ mục.

Ghi chú:

- `memory status --deep` thăm dò khả năng sẵn sàng của vector + embedding.
- `memory status --deep --index` chạy lập chỉ mục lại nếu kho lưu trữ ở trạng thái bẩn.
- `memory index --verbose` in chi tiết theo từng pha (nhà cung cấp, mô hình, nguồn, hoạt động theo lô).
- `memory status` bao gồm mọi đường dẫn bổ sung được cấu hình thông qua `memorySearch.extraPaths`.
