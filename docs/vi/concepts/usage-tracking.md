---
summary: "Các bề mặt theo dõi mức sử dụng và yêu cầu về thông tin xác thực"
read_when:
  - Bạn đang kết nối các bề mặt mức sử dụng/hạn ngạch của nhà cung cấp
  - Bạn cần giải thích hành vi theo dõi mức sử dụng hoặc yêu cầu xác thực
title: "Theo dõi mức sử dụng"
---

# Theo dõi mức sử dụng

## Nó là gì

- Lấy mức sử dụng/hạn ngạch của nhà cung cấp trực tiếp từ các endpoint mức sử dụng của họ.
- Không có chi phí ước tính; chỉ dùng các khung thời gian do nhà cung cấp báo cáo.

## Nó hiển thị ở đâu

- `/status` trong chat: thẻ trạng thái giàu emoji với token phiên + chi phí ước tính (chỉ API key). OpenClaw mặc định dùng **giờ cục bộ của máy chủ cho dấu thời gian truyền tải** và **múi giờ người dùng chỉ trong system prompt**.
- `/usage off|tokens|full` trong chat: chân trang mức sử dụng theo từng phản hồi (OAuth chỉ hiển thị token).
- `/usage cost` trong chat: tóm tắt chi phí cục bộ được tổng hợp từ nhật ký phiên OpenClaw.
- CLI: `openclaw status --usage` in ra phân tích đầy đủ theo từng nhà cung cấp.
- CLI: `openclaw channels list` in ra ảnh chụp mức sử dụng tương tự kèm theo cấu hình nhà cung cấp (dùng `--no-usage` để bỏ qua).
- Thanh menu macOS: mục “Usage” dưới Context (chỉ khi khả dụng).

## Nhà cung cấp + thông tin xác thực

- **Anthropic (Claude)**: token OAuth trong hồ sơ xác thực.
- **GitHub Copilot**: token OAuth trong hồ sơ xác thực.
- **Gemini CLI**: token OAuth trong hồ sơ xác thực.
- **Antigravity**: token OAuth trong hồ sơ xác thực.
- **OpenAI Codex**: token OAuth trong hồ sơ xác thực (dùng accountId khi có).
- **MiniMax**: khóa API (khóa gói coding; `MINIMAX_CODE_PLAN_KEY` hoặc `MINIMAX_API_KEY`); dùng cửa sổ gói coding 5 giờ.
- **z.ai**: khóa API qua biến môi trường/cấu hình/kho xác thực.

Mức sử dụng sẽ bị ẩn nếu không có thông tin xác thực OAuth/API tương ứng.
