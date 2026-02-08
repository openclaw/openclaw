---
summary: "Trung tâm lưu trữ VPS cho OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - Bạn muốn chạy Gateway trên đám mây
  - Bạn cần bản đồ nhanh các hướng dẫn VPS/lưu trữ
title: "Lưu trữ VPS"
x-i18n:
  source_path: vps.md
  source_hash: 96593a1550b56040
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:31Z
---

# Lưu trữ VPS

Trang trung tâm này liên kết đến các hướng dẫn VPS/lưu trữ được hỗ trợ và giải thích
cách triển khai trên đám mây ở mức tổng quan.

## Chọn nhà cung cấp

- **Railway** (thiết lập một cú nhấp + trên trình duyệt): [Railway](/install/railway)
- **Northflank** (thiết lập một cú nhấp + trên trình duyệt): [Northflank](/install/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/tháng (Always Free, ARM; dung lượng/đăng ký có thể hơi khó)
- **Fly.io**: [Fly.io](/install/fly)
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)
- **GCP (Compute Engine)**: [GCP](/install/gcp)
- **exe.dev** (VM + proxy HTTPS): [exe.dev](/install/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: cũng hoạt động rất tốt. Video hướng dẫn:
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)

## Cách hoạt động của thiết lập đám mây

- **Gateway chạy trên VPS** và quản lý trạng thái + workspace.
- Bạn kết nối từ laptop/điện thoại qua **Control UI** hoặc **Tailscale/SSH**.
- Xem VPS là nguồn sự thật và **sao lưu** trạng thái + workspace.
- Mặc định an toàn: giữ Gateway trên loopback và truy cập qua đường hầm SSH hoặc Tailscale Serve.
  Nếu bạn bind tới `lan`/`tailnet`, hãy yêu cầu `gateway.auth.token` hoặc `gateway.auth.password`.

Truy cập từ xa: [Gateway remote](/gateway/remote)  
Trung tâm nền tảng: [Platforms](/platforms)

## Sử dụng nodes với VPS

Bạn có thể giữ Gateway trên đám mây và ghép **nodes** trên các thiết bị cục bộ
(Mac/iOS/Android/headless). Nodes cung cấp màn hình/camera/canvas cục bộ và các khả năng `system.run`
trong khi Gateway vẫn ở trên đám mây.

Tài liệu: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
