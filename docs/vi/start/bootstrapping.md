---
summary: "Nghi thức khởi tạo tác tử gieo mầm không gian làm việc và các tệp danh tính"
read_when:
  - Hiểu điều gì xảy ra ở lần chạy tác tử đầu tiên
  - Giải thích nơi các tệp khởi tạo nằm ở đâu
  - Gỡ lỗi thiết lập danh tính trong quá trình hướng dẫn ban đầu
title: "Khởi tạo tác tử"
sidebarTitle: "Bootstrapping"
---

# Khởi tạo tác tử

Bootstrapping is the **first‑run** ritual that prepares an agent workspace and
collects identity details. It happens after onboarding, when the agent starts
for the first time.

## Bootstrapping làm gì

Ở lần chạy tác tử đầu tiên, OpenClaw khởi tạo không gian làm việc (mặc định
`~/.openclaw/workspace`):

- Gieo mầm `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Chạy một nghi thức hỏi & đáp ngắn (mỗi lần một câu hỏi).
- Ghi danh tính + tùy chọn vào `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Xóa `BOOTSTRAP.md` khi hoàn tất để đảm bảo chỉ chạy một lần.

## Nơi nó chạy

Bootstrapping always runs on the **gateway host**. If the macOS app connects to
a remote Gateway, the workspace and bootstrapping files live on that remote
machine.

<Note>
Khi Gateway chạy trên một máy khác, hãy chỉnh sửa các tệp không gian làm việc trên
máy chủ gateway (ví dụ: `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Tài liệu liên quan

- Onboarding ứng dụng macOS: [Onboarding](/start/onboarding)
- Bố cục không gian làm việc: [Agent workspace](/concepts/agent-workspace)
