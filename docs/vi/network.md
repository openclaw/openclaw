---
summary: "Trung tâm mạng: các bề mặt gateway, ghép cặp, khám phá và bảo mật"
read_when:
  - Bạn cần tổng quan về kiến trúc mạng và bảo mật
  - Bạn đang gỡ lỗi truy cập local so với tailnet hoặc ghép cặp
  - Bạn muốn danh sách tài liệu mạng chuẩn
title: "Mạng"
---

# Trung tâm mạng

Trung tâm này liên kết các tài liệu cốt lõi về cách OpenClaw kết nối, ghép cặp và bảo mật
thiết bị qua localhost, LAN và tailnet.

## Mô hình cốt lõi

- [Kiến trúc Gateway](/concepts/architecture)
- [Giao thức Gateway](/gateway/protocol)
- [Runbook Gateway](/gateway)
- [Bề mặt web + chế độ bind](/web)

## Ghép cặp + định danh

- [Tổng quan ghép cặp (DM + nodes)](/channels/pairing)
- [Ghép cặp node do Gateway sở hữu](/gateway/pairing)
- [CLI Thiết bị (ghép cặp + xoay vòng token)](/cli/devices)
- [CLI Ghép cặp (phê duyệt DM)](/cli/pairing)

Tin cậy cục bộ:

- Kết nối local (loopback hoặc địa chỉ tailnet của chính máy chủ gateway) có thể
  được tự động phê duyệt ghép cặp để giữ trải nghiệm cùng máy mượt mà.
- Các client tailnet/LAN không phải local vẫn yêu cầu phê duyệt ghép cặp rõ ràng.

## Khám phá + vận chuyển

- [Khám phá & vận chuyển](/gateway/discovery)
- [Bonjour / mDNS](/gateway/bonjour)
- [Truy cập từ xa (SSH)](/gateway/remote)
- [Tailscale](/gateway/tailscale)

## Nodes + vận chuyển

- [Tổng quan nodes](/nodes)
- [Giao thức Bridge (nodes legacy)](/gateway/bridge-protocol)
- [Runbook node: iOS](/platforms/ios)
- [Runbook node: Android](/platforms/android)

## Bảo mật

- [Tổng quan bảo mật](/gateway/security)
- [Tham chiếu cấu hình Gateway](/gateway/configuration)
- [Xử lý sự cố](/gateway/troubleshooting)
- [Doctor](/gateway/doctor)
