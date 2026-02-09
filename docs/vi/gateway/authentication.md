---
summary: "Xác thực mô hình: OAuth, khóa API và setup-token"
read_when:
  - Gỡ lỗi xác thực mô hình hoặc hết hạn OAuth
  - Tài liệu hóa xác thực hoặc lưu trữ thông tin xác thực
title: "Xác thực"
---

# Xác thực

Đối với tài khoản Anthropic, chúng tôi khuyến nghị sử dụng **API key**. Đối với các tài khoản Anthropic,
chúng tôi khuyến nghị sử dụng **API key**. Đối với quyền truy cập thuê bao Claude,
hãy dùng token tồn tại lâu được tạo bởi `claude setup-token`.

Xem [/concepts/oauth](/concepts/oauth) để biết đầy đủ luồng OAuth và cách bố trí
lưu trữ.

## Thiết lập Anthropic được khuyến nghị (khóa API)

Nếu bạn dùng Anthropic trực tiếp, hãy dùng khóa API.

1. Tạo khóa API trong Anthropic Console.
2. Đặt khóa trên **máy chủ gateway** (máy đang chạy `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Nếu Gateway chạy dưới systemd/launchd, nên đặt khóa trong
   `~/.openclaw/.env` để daemon có thể đọc:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Sau đó khởi động lại daemon (hoặc khởi động lại tiến trình Gateway) và kiểm tra
lại:

```bash
openclaw models status
openclaw doctor
```

Nếu bạn không muốn tự quản lý biến môi trường, trình hướng dẫn ban đầu có thể
lưu khóa API để daemon sử dụng: `openclaw onboard`.

Xem [Help](/help) để biết chi tiết về kế thừa env (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (xác thực thuê bao)

Đối với Anthropic, đường dẫn được khuyến nghị là **API key**. Nếu bạn đang dùng thuê bao Claude,
luồng setup-token cũng được hỗ trợ. Chạy nó trên **gateway host**:

```bash
claude setup-token
```

Sau đó dán vào OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Nếu token được tạo trên máy khác, hãy dán thủ công:

```bash
openclaw models auth paste-token --provider anthropic
```

Nếu bạn thấy lỗi Anthropic như:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…hãy dùng khóa API của Anthropic thay thế.

Nhập token thủ công (mọi nhà cung cấp; ghi `auth-profiles.json` + cập nhật cấu hình):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Kiểm tra thân thiện cho tự động hóa (thoát `1` khi hết hạn/thiếu,
`2` khi sắp hết hạn):

```bash
openclaw models status --check
```

Các script vận hành tùy chọn (systemd/Termux) được tài liệu hóa tại đây:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` yêu cầu TTY tương tác.

## Kiểm tra trạng thái xác thực mô hình

```bash
openclaw models status
openclaw doctor
```

## Kiểm soát thông tin xác thực được sử dụng

### Theo phiên (lệnh chat)

Dùng `/model <alias-or-id>@<profileId>` để ghim một thông tin xác thực của nhà cung cấp cho phiên
hiện tại (ví dụ id hồ sơ: `anthropic:default`, `anthropic:work`).

Dùng `/model` (hoặc `/model list`) cho bộ chọn gọn nhẹ; dùng
`/model status` cho chế độ xem đầy đủ (các ứng viên + hồ sơ xác thực kế tiếp,
kèm chi tiết endpoint của nhà cung cấp khi đã cấu hình).

### Theo từng tác tử (ghi đè CLI)

Đặt ghi đè thứ tự hồ sơ xác thực cho một tác tử (lưu trong `auth-profiles.json` của
tác tử đó):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Dùng `--agent <id>` để nhắm tới một tác tử cụ thể; bỏ qua để dùng tác tử mặc
định đã cấu hình.

## Xử lý sự cố

### “Không tìm thấy thông tin xác thực”

Nếu thiếu hồ sơ token Anthropic, hãy chạy `claude setup-token` trên **máy chủ
gateway**, rồi kiểm tra lại:

```bash
openclaw models status
```

### Token sắp hết hạn/đã hết hạn

Nếu profile bị thiếu, hãy chạy lại `claude setup-token` và dán lại token. Nếu hồ sơ
bị thiếu, hãy chạy lại `claude setup-token` và dán token lần nữa.

## Yêu cầu

- Gói thuê bao Claude Max hoặc Pro (cho `claude setup-token`)
- Đã cài Claude Code CLI (có sẵn lệnh `claude`)
