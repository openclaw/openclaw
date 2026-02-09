---
summary: "OpenProse: quy trình làm việc .prose, lệnh slash và trạng thái trong OpenClaw"
read_when:
  - Bạn muốn chạy hoặc viết các quy trình làm việc .prose
  - Bạn muốn bật plugin OpenProse
  - Bạn cần hiểu cách lưu trữ trạng thái
title: "OpenProse"
---

# OpenProse

OpenProse is a portable, markdown-first workflow format for orchestrating AI sessions. In OpenClaw it ships as a plugin that installs an OpenProse skill pack plus a `/prose` slash command. Các chương trình nằm trong các tệp `.prose` và có thể tạo ra nhiều tác nhân phụ với luồng điều khiển rõ ràng.

Trang chính thức: [https://www.prose.md](https://www.prose.md)

## Những gì nó có thể làm

- Nghiên cứu và tổng hợp đa tác tử với song song hóa tường minh.
- Quy trình làm việc lặp lại, an toàn phê duyệt (đánh giá mã, phân loại sự cố, pipeline nội dung).
- Các chương trình `.prose` có thể tái sử dụng, chạy trên các runtime tác tử được hỗ trợ.

## Cài đặt + bật

Các plugin đi kèm bị vô hiệu hóa theo mặc định. Bật OpenProse:

```bash
openclaw plugins enable open-prose
```

Khởi động lại Gateway sau khi bật plugin.

Bản dev/checkout cục bộ: `openclaw plugins install ./extensions/open-prose`

Tài liệu liên quan: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## Lệnh slash

OpenProse đăng ký `/prose` như một lệnh kỹ năng có thể được người dùng gọi. Nó định tuyến tới các chỉ thị VM của OpenProse và sử dụng các công cụ OpenClaw ở bên dưới.

Các lệnh thường dùng:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Ví dụ: một tệp `.prose` đơn giản

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## Vị trí tệp

OpenProse lưu trạng thái dưới `.prose/` trong workspace của bạn:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

Các tác tử bền vững cấp người dùng nằm tại:

```
~/.prose/agents/
```

## Chế độ trạng thái

OpenProse hỗ trợ nhiều backend trạng thái:

- **filesystem** (mặc định): `.prose/runs/...`
- **in-context**: tạm thời, cho các chương trình nhỏ
- **sqlite** (thử nghiệm): yêu cầu binary `sqlite3`
- **postgres** (thử nghiệm): yêu cầu `psql` và một chuỗi kết nối

Ghi chú:

- sqlite/postgres là tùy chọn và đang thử nghiệm.
- Thông tin xác thực postgres đi vào log của tác tử con; hãy dùng CSDL riêng với quyền tối thiểu cần thiết.

## Chương trình từ xa

`/prose run <handle/slug>` được phân giải thành `https://p.prose.md/<handle>/<slug>`.
Các URL trực tiếp được tải nguyên trạng. Điều này sử dụng công cụ `web_fetch` (hoặc `exec` cho POST).

## Ánh xạ runtime OpenClaw

Các chương trình OpenProse ánh xạ sang các nguyên thủy của OpenClaw:

| Khái niệm OpenProse      | Công cụ OpenClaw |
| ------------------------ | ---------------- |
| Tạo phiên / Công cụ Task | `sessions_spawn` |
| Đọc/ghi tệp              | `read` / `write` |
| Tải web                  | `web_fetch`      |

Nếu danh sách cho phép công cụ của bạn chặn các công cụ này, các chương trình OpenProse sẽ thất bại. Xem [Cấu hình Skills](/tools/skills-config).

## Bảo mật + phê duyệt

Hãy coi các tệp `.prose` như mã nguồn. Xem xét trước khi chạy. Sử dụng danh sách cho phép công cụ OpenClaw và các cổng phê duyệt để kiểm soát tác dụng phụ.

Đối với các quy trình làm việc xác định và có cổng phê duyệt, hãy so sánh với [Lobster](/tools/lobster).
