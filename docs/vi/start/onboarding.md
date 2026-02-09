---
summary: "Luồng hướng dẫn ban đầu khi chạy lần đầu cho OpenClaw (ứng dụng macOS)"
read_when:
  - Thiết kế trợ lý hướng dẫn ban đầu trên macOS
  - Triển khai xác thực hoặc thiết lập danh tính
title: "Hướng dẫn ban đầu (Ứng dụng macOS)"
sidebarTitle: "Onboarding: macOS App"
---

# Hướng dẫn ban đầu (Ứng dụng macOS)

Tài liệu này mô tả luồng onboarding chạy lần đầu **hiện tại**. Mục tiêu là một trải nghiệm “ngày 0” mượt mà: chọn nơi Gateway chạy, kết nối xác thực, chạy trình hướng dẫn, và để agent tự khởi tạo.

<Steps>
<Step title="Approve macOS warning">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="Approve find local networks">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="Welcome and security notice">
<Frame caption="Đọc thông báo bảo mật được hiển thị và quyết định cho phù hợp">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>
</Step>
<Step title="Local vs Remote">
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
**Gateway auth tip:**
- The wizard now generates a **token** even for loopback, so local WS clients must authenticate.
- Nếu bạn tắt xác thực, bất kỳ tiến trình cục bộ nào cũng có thể kết nối; chỉ dùng cách này trên các máy hoàn toàn đáng tin cậy.
- Dùng **token** cho truy cập đa máy hoặc khi bind không phải loopback.
</Tip>
</Step>
<Step title="Permissions">
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
<Step title="Onboarding Chat (dedicated session)">
  Sau khi thiết lập, ứng dụng sẽ mở một phiên chat onboarding riêng để agent tự giới thiệu và hướng dẫn các bước tiếp theo. Điều này giúp tách hướng dẫn lần chạy đầu khỏi các cuộc trò chuyện thông thường của bạn. Xem [Bootstrapping](/start/bootstrapping) để biết điều gì xảy ra trên máy chủ gateway trong lần chạy agent đầu tiên.
</Step>
</Steps>
