---
summary: "OpenProse: quy trình làm việc .prose, lệnh slash và trạng thái trong OpenClaw"
read_when:
  - Bạn muốn chạy hoặc viết các quy trình làm việc .prose
  - Bạn muốn bật plugin OpenProse
  - Bạn cần hiểu cách lưu trữ trạng thái
title: "OpenProse"
x-i18n:
  source_path: prose.md
  source_hash: 53c161466d278e5f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:53Z
---

# OpenProse

OpenProse là một định dạng quy trình làm việc di động, ưu tiên markdown để điều phối các phiên AI. Trong OpenClaw, nó được cung cấp dưới dạng một plugin cài đặt một gói skill OpenProse cùng với một lệnh slash `/prose`. Các chương trình nằm trong các tệp `.prose` và có thể tạo nhiều tác tử con với luồng điều khiển tường minh.

Trang chính thức: [https://www.prose.md](https://www.prose.md)

## Những gì nó có thể làm

- Nghiên cứu và tổng hợp đa tác tử với song song hóa tường minh.
- Quy trình làm việc lặp lại, an toàn phê duyệt (đánh giá mã, phân loại sự cố, pipeline nội dung).
- Các chương trình `.prose` có thể tái sử dụng, chạy trên các runtime tác tử được hỗ trợ.

## Cài đặt + bật

Các plugin đi kèm bị tắt theo mặc định. Bật OpenProse:

```bash
openclaw plugins enable open-prose
```

Khởi động lại Gateway sau khi bật plugin.

Bản dev/checkout cục bộ: `openclaw plugins install ./extensions/open-prose`

Tài liệu liên quan: [Plugins](/tools/plugin), [Plugin manifest](/plugins/manifest), [Skills](/tools/skills).

## Lệnh slash

OpenProse đăng ký `/prose` như một lệnh skill do người dùng gọi. Lệnh này định tuyến tới các chỉ dẫn VM của OpenProse và sử dụng các công cụ OpenClaw ở phía dưới.

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

`/prose run <handle/slug>` phân giải thành `https://p.prose.md/<handle>/<slug>`.
Các URL trực tiếp được tải nguyên trạng. Việc này sử dụng công cụ `web_fetch` (hoặc `exec` cho POST).

## Ánh xạ runtime OpenClaw

Các chương trình OpenProse ánh xạ sang các nguyên thủy của OpenClaw:

| Khái niệm OpenProse      | Công cụ OpenClaw |
| ------------------------ | ---------------- |
| Tạo phiên / Công cụ Task | `sessions_spawn` |
| Đọc/ghi tệp              | `read` / `write` |
| Tải web                  | `web_fetch`      |

Nếu danh sách cho phép công cụ của bạn chặn các công cụ này, các chương trình OpenProse sẽ thất bại. Xem [Skills config](/tools/skills-config).

## Bảo mật + phê duyệt

Hãy coi các tệp `.prose` như mã nguồn. Rà soát trước khi chạy. Sử dụng danh sách cho phép công cụ và cổng phê duyệt của OpenClaw để kiểm soát các tác dụng phụ.

Đối với các quy trình làm việc xác định và có cổng phê duyệt, hãy so sánh với [Lobster](/tools/lobster).
