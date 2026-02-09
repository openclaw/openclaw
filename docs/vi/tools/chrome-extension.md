---
summary: "Tiện ích Chrome: cho phép OpenClaw điều khiển tab Chrome hiện có của bạn"
read_when:
  - Bạn muốn tác tử điều khiển một tab Chrome hiện có (nút trên thanh công cụ)
  - Bạn cần Gateway từ xa + tự động hóa trình duyệt cục bộ qua Tailscale
  - Bạn muốn hiểu các hệ quả bảo mật của việc chiếm quyền trình duyệt
title: "Tiện ích Chrome"
---

# Tiện ích Chrome (browser relay)

Tiện ích Chrome của OpenClaw cho phép tác tử điều khiển **các tab Chrome hiện có** của bạn (cửa sổ Chrome thông thường) thay vì khởi chạy một hồ sơ Chrome riêng do openclaw quản lý.

Việc gắn/tách được thực hiện qua **một nút duy nhất trên thanh công cụ Chrome**.

## Nó là gì (khái niệm)

Có ba phần:

- **Dịch vụ điều khiển trình duyệt** (Gateway hoặc node): API mà tác tử/công cụ gọi (thông qua Gateway)
- **Máy chủ relay cục bộ** (loopback CDP): cầu nối giữa máy chủ điều khiển và tiện ích (`http://127.0.0.1:18792` theo mặc định)
- **Tiện ích Chrome MV3**: gắn vào tab đang hoạt động bằng `chrome.debugger` và chuyển tiếp các thông điệp CDP tới relay

Sau đó OpenClaw điều khiển tab đã gắn thông qua bề mặt công cụ `browser` thông thường (chọn đúng hồ sơ).

## Cài đặt / tải (unpacked)

1. Cài đặt tiện ích vào một đường dẫn cục bộ ổn định:

```bash
openclaw browser extension install
```

2. In ra đường dẫn thư mục tiện ích đã cài đặt:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- Bật “Developer mode”
- “Load unpacked” → chọn thư mục đã in ở trên

4. Ghim tiện ích.

## Cập nhật (không cần bước build)

12. Extension được phát hành kèm trong bản phát hành OpenClaw (gói npm) dưới dạng các tệp tĩnh. 43. Không có bước “build” riêng biệt.

Sau khi nâng cấp OpenClaw:

- Chạy lại `openclaw browser extension install` để làm mới các tệp đã cài dưới thư mục trạng thái OpenClaw của bạn.
- Chrome → `chrome://extensions` → nhấp “Reload” trên tiện ích.

## Sử dụng (không cần cấu hình thêm)

OpenClaw đi kèm một hồ sơ trình duyệt tích hợp có tên `chrome` nhắm tới relay của tiện ích trên cổng mặc định.

Cách dùng:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Công cụ của tác tử: `browser` với `profile="chrome"`

Nếu bạn muốn tên khác hoặc cổng relay khác, hãy tạo hồ sơ của riêng bạn:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## Gắn / tách (nút thanh công cụ)

- Mở tab bạn muốn OpenClaw điều khiển.
- Nhấp vào biểu tượng tiện ích.
  - Huy hiệu hiển thị `ON` khi đã gắn.
- Nhấp lại để tách.

## Nó điều khiển tab nào?

- Nó **không** tự động điều khiển “bất kỳ tab nào bạn đang xem”.
- Nó chỉ điều khiển **những tab bạn đã gắn một cách tường minh** bằng cách nhấp nút trên thanh công cụ.
- Để chuyển: mở tab khác và nhấp biểu tượng tiện ích ở tab đó.

## Huy hiệu + lỗi thường gặp

- `ON`: đã gắn; OpenClaw có thể điều khiển tab đó.
- `…`: đang kết nối tới relay cục bộ.
- `!`: không thể truy cập relay (thường gặp nhất: máy chủ relay của trình duyệt không chạy trên máy này).

Nếu bạn thấy `!`:

- Đảm bảo Gateway đang chạy cục bộ (thiết lập mặc định), hoặc chạy một node host trên máy này nếu Gateway chạy ở nơi khác.
- Mở trang Options của tiện ích; trang này hiển thị relay có truy cập được hay không.

## Gateway từ xa (dùng node host)

### Gateway cục bộ (cùng máy với Chrome) — thường **không cần bước bổ sung**

If the Gateway runs on the same machine as Chrome, it starts the browser control service on loopback
and auto-starts the relay server. The extension talks to the local relay; the CLI/tool calls go to the Gateway.

### Gateway từ xa (Gateway chạy ở nơi khác) — **chạy node host**

16. Nếu Gateway của bạn chạy trên một máy khác, hãy khởi động một node host trên máy chạy Chrome.
17. Gateway sẽ proxy các hành động của trình duyệt tới node đó; extension + relay vẫn ở cục bộ trên máy trình duyệt.

Nếu có nhiều node được kết nối, hãy ghim một node bằng `gateway.nodes.browser.node` hoặc đặt `gateway.nodes.browser.mode`.

## Sandboxing (tool containers)

Nếu phiên tác tử của bạn được sandbox (`agents.defaults.sandbox.mode != "off"`), công cụ `browser` có thể bị hạn chế:

- Theo mặc định, các phiên sandbox thường nhắm tới **trình duyệt sandbox** (`target="sandbox"`), không phải Chrome trên máy chủ của bạn.
- Việc chiếm quyền relay của tiện ích Chrome yêu cầu điều khiển máy chủ điều khiển trình duyệt của **host**.

Tùy chọn:

- Dễ nhất: dùng tiện ích từ một phiên/tác tử **không sandbox**.
- Hoặc cho phép điều khiển trình duyệt host cho các phiên sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Sau đó đảm bảo công cụ không bị chặn bởi chính sách công cụ, và (nếu cần) gọi `browser` với `target="host"`.

Gỡ lỗi: `openclaw sandbox explain`

## Mẹo truy cập từ xa

- Giữ Gateway và node host trên cùng tailnet; tránh phơi bày các cổng relay ra LAN hoặc Internet công cộng.
- Ghép cặp các node một cách có chủ đích; tắt định tuyến proxy trình duyệt nếu bạn không muốn điều khiển từ xa (`gateway.nodes.browser.mode="off"`).

## Cách hoạt động của “đường dẫn tiện ích”

`openclaw browser extension path` in ra thư mục **đã cài đặt** trên đĩa chứa các tệp của tiện ích.

18. CLI cố ý **không** in ra đường dẫn `node_modules`. 19. Luôn chạy `openclaw browser extension install` trước để sao chép extension tới một vị trí ổn định dưới thư mục trạng thái OpenClaw của bạn.

Nếu bạn di chuyển hoặc xóa thư mục cài đặt đó, Chrome sẽ đánh dấu tiện ích là bị hỏng cho đến khi bạn tải lại từ một đường dẫn hợp lệ.

## Hệ quả bảo mật (hãy đọc)

20. Điều này rất mạnh mẽ và rủi ro. 21. Hãy coi nó như việc trao cho mô hình “đôi tay trên trình duyệt của bạn”.

- The extension uses Chrome’s debugger API (`chrome.debugger`). 23. Khi được gắn (attached), mô hình có thể:
  - nhấp/gõ/điều hướng trong tab đó
  - đọc nội dung trang
  - truy cập bất cứ thứ gì mà phiên đăng nhập của tab đó có quyền truy cập
- **Điều này không được cô lập** như hồ sơ chuyên dụng do openclaw quản lý.
  - Nếu bạn gắn vào hồ sơ/tab dùng hằng ngày, bạn đang cấp quyền truy cập vào trạng thái tài khoản đó.

Khuyến nghị:

- Ưu tiên một hồ sơ Chrome chuyên dụng (tách biệt với duyệt web cá nhân) cho việc dùng relay tiện ích.
- Giữ Gateway và mọi node host chỉ trong tailnet; dựa vào xác thực Gateway + ghép cặp node.
- Tránh phơi bày các cổng relay qua LAN (`0.0.0.0`) và tránh Funnel (công khai).
- Relay chặn các nguồn không phải tiện ích và yêu cầu một token xác thực nội bộ cho các client CDP.

Liên quan:

- Tổng quan công cụ trình duyệt: [Browser](/tools/browser)
- Kiểm toán bảo mật: [Security](/gateway/security)
- Thiết lập Tailscale: [Tailscale](/gateway/tailscale)
