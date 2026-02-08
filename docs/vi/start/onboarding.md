---
summary: "Luồng hướng dẫn ban đầu khi chạy lần đầu cho OpenClaw (ứng dụng macOS)"
read_when:
  - Thiết kế trợ lý hướng dẫn ban đầu trên macOS
  - Triển khai xác thực hoặc thiết lập danh tính
title: "Hướng dẫn ban đầu (Ứng dụng macOS)"
sidebarTitle: "Onboarding: macOS App"
x-i18n:
  source_path: start/onboarding.md
  source_hash: 45f912067527158f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:21Z
---

# Hướng dẫn ban đầu (Ứng dụng macOS)

Tài liệu này mô tả luồng hướng dẫn ban đầu khi chạy lần đầu **hiện tại**. Mục tiêu là
mang lại trải nghiệm “ngày 0” mượt mà: chọn nơi Gateway chạy, kết nối xác thực, chạy
trình hướng dẫn, và để tác tử tự khởi tạo.

<Steps>
<Step title="Phê duyệt cảnh báo macOS">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Phê duyệt tìm mạng cục bộ">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Chào mừng và thông báo bảo mật">
<Frame caption="Đọc thông báo bảo mật được hiển thị và quyết định cho phù hợp">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Cục bộ hay Từ xa">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway** chạy ở đâu?

- **Máy này (chỉ cục bộ):** hướng dẫn ban đầu có thể chạy các luồng OAuth và ghi thông tin xác thực
  cục bộ.
- **Từ xa (qua SSH/Tailnet):** hướng dẫn ban đầu **không** chạy OAuth cục bộ;
  thông tin xác thực phải tồn tại trên máy chủ gateway.
- **Cấu hình sau:** bỏ qua thiết lập và để ứng dụng ở trạng thái chưa cấu hình.

<Tip>
**Mẹo xác thực Gateway:**
- Trình hướng dẫn hiện tạo **token** ngay cả cho local loopback, vì vậy các client WS cục bộ phải xác thực.
- Nếu bạn tắt xác thực, mọi tiến trình cục bộ đều có thể kết nối; chỉ dùng cách này trên các máy hoàn toàn đáng tin cậy.
- Dùng **token** cho truy cập nhiều máy hoặc các bind không phải loopback.
</Tip>
</Step>
<Step title="Quyền">
<Frame caption="Chọn các quyền bạn muốn cấp cho OpenClaw">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

Hướng dẫn ban đầu yêu cầu các quyền TCC cần thiết cho:

- Tự động hóa (AppleScript)
- Thông báo
- Trợ năng
- Ghi màn hình
- Micro
- Nhận dạng giọng nói
- Camera
- Vị trí

</Step>
<Step title="CLI">
  <Info>Bước này là tùy chọn</Info>
  Ứng dụng có thể cài đặt CLI `openclaw` toàn cục qua npm/pnpm để các
  quy trình làm việc trên terminal và các tác vụ launchd hoạt động ngay.
</Step>
<Step title="Trò chuyện hướng dẫn ban đầu (phiên riêng)">
  Sau khi thiết lập, ứng dụng mở một phiên trò chuyện hướng dẫn ban đầu chuyên biệt để tác tử
  tự giới thiệu và hướng dẫn các bước tiếp theo. Cách này giữ phần hướng dẫn lần chạy đầu
  tách biệt khỏi cuộc trò chuyện thông thường của bạn. Xem [Bootstrapping](/start/bootstrapping) để biết
  điều gì diễn ra trên máy chủ gateway trong lần chạy tác tử đầu tiên.
</Step>
</Steps>
