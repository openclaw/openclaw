---
summary: "Nghi thức khởi tạo tác tử gieo mầm không gian làm việc và các tệp danh tính"
read_when:
  - Hiểu điều gì xảy ra ở lần chạy tác tử đầu tiên
  - Giải thích nơi các tệp khởi tạo nằm ở đâu
  - Gỡ lỗi thiết lập danh tính trong quá trình hướng dẫn ban đầu
title: "Khởi tạo tác tử"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:09Z
---

# Khởi tạo tác tử

Bootstrapping là nghi thức **chạy lần đầu** chuẩn bị không gian làm việc của tác tử và
thu thập thông tin danh tính. Nó diễn ra sau onboarding, khi tác tử khởi động
lần đầu tiên.

## Bootstrapping làm gì

Ở lần chạy tác tử đầu tiên, OpenClaw khởi tạo không gian làm việc (mặc định
`~/.openclaw/workspace`):

- Gieo mầm `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Chạy một nghi thức hỏi & đáp ngắn (mỗi lần một câu hỏi).
- Ghi danh tính + tùy chọn vào `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Xóa `BOOTSTRAP.md` khi hoàn tất để đảm bảo chỉ chạy một lần.

## Nơi nó chạy

Bootstrapping luôn chạy trên **máy chủ gateway**. Nếu ứng dụng macOS kết nối tới
một Gateway từ xa, không gian làm việc và các tệp bootstrapping sẽ nằm trên máy
từ xa đó.

<Note>
Khi Gateway chạy trên một máy khác, hãy chỉnh sửa các tệp không gian làm việc trên
máy chủ gateway (ví dụ: `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Tài liệu liên quan

- Onboarding ứng dụng macOS: [Onboarding](/start/onboarding)
- Bố cục không gian làm việc: [Agent workspace](/concepts/agent-workspace)
