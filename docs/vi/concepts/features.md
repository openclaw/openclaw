---
summary: "Các khả năng của OpenClaw trên các kênh, định tuyến, media và trải nghiệm người dùng."
read_when:
  - Bạn muốn danh sách đầy đủ những gì OpenClaw hỗ trợ
title: "Tính năng"
x-i18n:
  source_path: concepts/features.md
  source_hash: 1b6aee0bfda75182
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:31Z
---

## Điểm nổi bật

<Columns>
  <Card title="Kênh" icon="message-square">
    WhatsApp, Telegram, Discord và iMessage với một Gateway duy nhất.
  </Card>
  <Card title="Plugin" icon="plug">
    Thêm Mattermost và nhiều nền tảng khác bằng các extension.
  </Card>
  <Card title="Định tuyến" icon="route">
    Định tuyến đa tác tử với các phiên được cô lập.
  </Card>
  <Card title="Media" icon="image">
    Hình ảnh, âm thanh và tài liệu hai chiều.
  </Card>
  <Card title="Ứng dụng và UI" icon="monitor">
    Web Control UI và ứng dụng đồng hành macOS.
  </Card>
  <Card title="Nút di động" icon="smartphone">
    Các nút iOS và Android với hỗ trợ Canvas.
  </Card>
</Columns>

## Danh sách đầy đủ

- Tích hợp WhatsApp qua WhatsApp Web (Baileys)
- Hỗ trợ bot Telegram (grammY)
- Hỗ trợ bot Discord (channels.discord.js)
- Hỗ trợ bot Mattermost (plugin)
- Tích hợp iMessage qua imsg CLI cục bộ (macOS)
- Cầu nối tác tử cho Pi ở chế độ RPC với streaming công cụ
- Streaming và chunking cho phản hồi dài
- Định tuyến đa tác tử cho các phiên cô lập theo từng workspace hoặc người gửi
- Xác thực thuê bao cho Anthropic và OpenAI qua OAuth
- Phiên: chat trực tiếp gộp vào `main` dùng chung; nhóm được cô lập
- Hỗ trợ chat nhóm với kích hoạt dựa trên mention
- Hỗ trợ media cho hình ảnh, âm thanh và tài liệu
- Hook chuyển giọng nói thành văn bản cho voice note (tùy chọn)
- WebChat và ứng dụng menu bar macOS
- Nút iOS với ghép cặp và bề mặt Canvas
- Nút Android với ghép cặp, Canvas, chat và camera

<Note>
Các đường dẫn Legacy Claude, Codex, Gemini và Opencode đã bị loại bỏ. Pi là
đường dẫn tác tử lập trình duy nhất.
</Note>
