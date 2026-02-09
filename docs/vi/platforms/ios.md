---
summary: "Ứng dụng node iOS: kết nối tới Gateway, ghép cặp, canvas và xử lý sự cố"
read_when:
  - Ghép cặp hoặc kết nối lại node iOS
  - Chạy ứng dụng iOS từ mã nguồn
  - Gỡ lỗi khám phá gateway hoặc các lệnh canvas
title: "Ứng dụng iOS"
---

# Ứng dụng iOS (Node)

Availability: internal preview. The iOS app is not publicly distributed yet.

## Chức năng

- Kết nối tới Gateway qua WebSocket (LAN hoặc tailnet).
- Cung cấp các khả năng của node: Canvas, chụp màn hình, chụp camera, vị trí, chế độ nói, kích hoạt bằng giọng nói.
- Nhận các lệnh `node.invoke` và báo cáo các sự kiện trạng thái của node.

## Yêu cầu

- Gateway chạy trên một thiết bị khác (macOS, Linux hoặc Windows qua WSL2).
- Đường dẫn mạng:
  - Cùng LAN qua Bonjour, **hoặc**
  - Tailnet qua unicast DNS-SD (ví dụ domain: `openclaw.internal.`), **hoặc**
  - Nhập host/cổng thủ công (dự phòng).

## Khởi động nhanh (ghép cặp + kết nối)

1. Khởi động Gateway:

```bash
openclaw gateway --port 18789
```

2. Trong ứng dụng iOS, mở Settings và chọn một gateway đã được phát hiện (hoặc bật Manual Host và nhập host/cổng).

3. Phê duyệt yêu cầu ghép cặp trên máy chủ gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Xác minh kết nối:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Các cách khám phá

### Bonjour (LAN)

The Gateway advertises `_openclaw-gw._tcp` on `local.`. The iOS app lists these automatically.

### Tailnet (xuyên mạng)

Nếu mDNS bị chặn, hãy sử dụng một vùng DNS-SD unicast (chọn một domain; ví dụ: `openclaw.internal.`) và Tailscale split DNS.
Xem [Bonjour](/gateway/bonjour) để biết ví dụ CoreDNS.

### Host/cổng thủ công

Trong Settings, bật **Manual Host** và nhập host + cổng của gateway (mặc định `18789`).

## Canvas + A2UI

The iOS node renders a WKWebView canvas. Use `node.invoke` to drive it:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Ghi chú:

- Máy chủ canvas của Gateway phục vụ `/__openclaw__/canvas/` và `/__openclaw__/a2ui/`.
- Node iOS tự động điều hướng tới A2UI khi kết nối nếu có quảng bá URL máy chủ canvas.
- Quay lại scaffold tích hợp sẵn bằng `canvas.navigate` và `{"url":""}`.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Kích hoạt bằng giọng nói + chế độ nói

- Kích hoạt bằng giọng nói và chế độ nói có sẵn trong Settings.
- iOS có thể tạm dừng âm thanh nền; hãy coi các tính năng giọng nói là best-effort khi ứng dụng không ở trạng thái hoạt động.

## Lỗi thường gặp

- `NODE_BACKGROUND_UNAVAILABLE`: đưa ứng dụng iOS lên foreground (các lệnh canvas/camera/màn hình yêu cầu điều này).
- `A2UI_HOST_NOT_CONFIGURED`: Gateway không quảng bá URL máy chủ canvas; kiểm tra `canvasHost` trong [Cấu hình Gateway](/gateway/configuration).
- Không thấy lời nhắc ghép cặp: chạy `openclaw nodes pending` và phê duyệt thủ công.
- Kết nối lại thất bại sau khi cài lại: token ghép cặp trong Keychain đã bị xóa; hãy ghép cặp lại node.

## Tài liệu liên quan

- [Pairing](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
