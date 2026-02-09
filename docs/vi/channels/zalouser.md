---
summary: "Hỗ trợ tài khoản Zalo cá nhân thông qua zca-cli (đăng nhập QR), khả năng và cấu hình"
read_when:
  - Thiết lập Zalo Personal cho OpenClaw
  - Gỡ lỗi đăng nhập hoặc luồng tin nhắn Zalo Personal
title: "Zalo Personal"
---

# Zalo Personal (không chính thức)

Trạng thái: thử nghiệm. Tích hợp này tự động hóa một **tài khoản Zalo cá nhân** thông qua `zca-cli`.

> **Warning:** This is an unofficial integration and may result in account suspension/ban. Tự chịu rủi ro khi sử dụng.

## Plugin bắt buộc

Zalo Personal được phân phối dưới dạng plugin và không đi kèm trong bản cài đặt lõi.

- Cài đặt qua CLI: `openclaw plugins install @openclaw/zalouser`
- Hoặc từ bản checkout mã nguồn: `openclaw plugins install ./extensions/zalouser`
- Chi tiết: [Plugins](/tools/plugin)

## Điều kiện tiên quyết: zca-cli

Máy Gateway phải có sẵn binary `zca` trong `PATH`.

- Kiểm tra: `zca --version`
- Nếu thiếu, cài đặt zca-cli (xem `extensions/zalouser/README.md` hoặc tài liệu zca-cli thượng nguồn).

## Thiết lập nhanh (cho người mới)

1. Cài đặt plugin (xem ở trên).
2. Đăng nhập (QR, trên máy Gateway):
   - `openclaw channels login --channel zalouser`
   - Quét mã QR trong terminal bằng ứng dụng Zalo trên điện thoại.
3. Bật kênh:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Khởi động lại Gateway (hoặc hoàn tất hướng dẫn ban đầu).
5. Quyền truy cập DM mặc định là ghép cặp; phê duyệt mã ghép cặp khi liên hệ lần đầu.

## Nó là gì

- Sử dụng `zca listen` để nhận tin nhắn đến.
- Sử dụng `zca msg ...` để gửi phản hồi (văn bản/media/liên kết).
- Được thiết kế cho các trường hợp dùng “tài khoản cá nhân” khi Zalo Bot API không khả dụng.

## Đặt tên

Channel id là `zalouser` để làm rõ rằng đây là tự động hóa **tài khoản người dùng Zalo cá nhân** (không chính thức). Chúng tôi giữ `zalo` để dành cho khả năng tích hợp API Zalo chính thức trong tương lai.

## Tìm ID (danh bạ)

Dùng CLI danh bạ để khám phá người/nhóm và ID của họ:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Giới hạn

- Văn bản gửi đi được chia nhỏ khoảng ~2000 ký tự (giới hạn của client Zalo).
- Streaming bị chặn theo mặc định.

## Kiểm soát truy cập (DM)

`channels.zalouser.dmPolicy` hỗ trợ: `pairing | allowlist | open | disabled` (mặc định: `pairing`).
`channels.zalouser.allowFrom` accepts user IDs or names. Trình hướng dẫn sẽ phân giải tên thành ID thông qua `zca friend find` khi khả dụng.

Phê duyệt qua:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Truy cập nhóm (tùy chọn)

- Default: `channels.zalouser.groupPolicy = "open"` (groups allowed). Use `channels.defaults.groupPolicy` to override the default when unset.
- Giới hạn theo danh sách cho phép với:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (khóa là ID hoặc tên nhóm)
- Chặn tất cả nhóm: `channels.zalouser.groupPolicy = "disabled"`.
- Trình cấu hình có thể nhắc nhập danh sách cho phép nhóm.
- Khi khởi động, OpenClaw phân giải tên nhóm/người trong danh sách cho phép sang ID và ghi log ánh xạ; các mục không phân giải được sẽ giữ nguyên như đã nhập.

Ví dụ:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Đa tài khoản

Các tài khoản ánh xạ tới các profile zca. Ví dụ:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Xử lý sự cố

**Không tìm thấy `zca`:**

- Cài đặt zca-cli và đảm bảo nó nằm trong `PATH` cho tiến trình Gateway.

**Đăng nhập không được lưu:**

- `openclaw channels status --probe`
- Đăng nhập lại: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
