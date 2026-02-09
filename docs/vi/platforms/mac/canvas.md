---
summary: "Bảng Canvas do tác tử điều khiển được nhúng qua WKWebView + cơ chế URL tùy chỉnh"
read_when:
  - Triển khai bảng Canvas trên macOS
  - Thêm điều khiển tác tử cho không gian làm việc trực quan
  - Gỡ lỗi việc tải Canvas trong WKWebView
title: "Canvas"
---

# Canvas (ứng dụng macOS)

Ứng dụng macOS nhúng một **Canvas panel** do agent điều khiển bằng `WKWebView`. It
is a lightweight visual workspace for HTML/CSS/JS, A2UI, and small interactive
UI surfaces.

## Canvas nằm ở đâu

Trạng thái Canvas được lưu dưới Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Bảng Canvas phục vụ các tệp đó thông qua **cơ chế URL tùy chỉnh**:

- `openclaw-canvas://<session>/<path>`

Ví dụ:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Nếu không có `index.html` ở thư mục gốc, ứng dụng sẽ hiển thị **trang khung dựng sẵn**.

## Hành vi của bảng

- Bảng không viền, có thể thay đổi kích thước, được neo gần thanh menu (hoặc con trỏ chuột).
- Ghi nhớ kích thước/vị trí theo từng phiên.
- Tự động tải lại khi các tệp Canvas cục bộ thay đổi.
- Chỉ một bảng Canvas hiển thị tại một thời điểm (phiên sẽ được chuyển khi cần).

Canvas có thể bị vô hiệu hóa từ Cài đặt → **Allow Canvas**. Khi bị vô hiệu hóa, các lệnh node canvas
trả về `CANVAS_DISABLED`.

## Bề mặt API cho tác tử

Canvas được mở ra qua **Gateway WebSocket**, vì vậy tác tử có thể:

- hiển thị/ẩn bảng
- điều hướng tới một đường dẫn hoặc URL
- thực thi JavaScript
- chụp ảnh snapshot

Ví dụ CLI:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Ghi chú:

- `canvas.navigate` chấp nhận **đường dẫn Canvas cục bộ**, URL `http(s)` và URL `file://`.
- Nếu bạn truyền `"/"`, Canvas sẽ hiển thị khung dựng cục bộ hoặc `index.html`.

## A2UI trong Canvas

A2UI is hosted by the Gateway canvas host and rendered inside the Canvas panel.
When the Gateway advertises a Canvas host, the macOS app auto‑navigates to the
A2UI host page on first open.

URL host A2UI mặc định:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### Lệnh A2UI (v0.8)

Canvas hiện chấp nhận các thông điệp server→client **A2UI v0.8**:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) chưa được hỗ trợ.

Ví dụ CLI:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Kiểm tra nhanh:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Kích hoạt tác tử chạy từ Canvas

Canvas có thể kích hoạt các lần chạy tác tử mới thông qua deep link:

- `openclaw://agent?...`

Ví dụ (trong JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

Ứng dụng sẽ yêu cầu xác nhận trừ khi có khóa hợp lệ được cung cấp.

## Ghi chú bảo mật

- Cơ chế Canvas chặn truy cập vượt thư mục; tệp phải nằm dưới thư mục gốc của phiên.
- Nội dung Canvas cục bộ dùng cơ chế tùy chỉnh (không cần máy chủ loopback).
- Các URL `http(s)` bên ngoài chỉ được cho phép khi được điều hướng một cách rõ ràng.
