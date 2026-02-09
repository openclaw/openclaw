---
summary: "Tham chiếu CLI cho `openclaw directory` (self, peers, groups)"
read_when:
  - Bạn muốn tra cứu ID liên hệ/nhóm/self cho một kênh
  - Bạn đang phát triển bộ điều hợp danh bạ kênh
title: "directory"
---

# `openclaw directory`

Tra cứu danh bạ cho các kênh có hỗ trợ (liên hệ/peers, nhóm và “tôi”).

## Cờ dùng chung

- `--channel <name>`: id/bí danh kênh (bắt buộc khi cấu hình nhiều kênh; tự động khi chỉ có một kênh)
- `--account <id>`: id tài khoản (mặc định: tài khoản mặc định của kênh)
- `--json`: xuất JSON

## Ghi chú

- `directory` nhằm giúp bạn tìm các ID có thể dán vào các lệnh khác (đặc biệt là `openclaw message send --target ...`).
- Với nhiều kênh, kết quả dựa trên cấu hình (danh sách cho phép / nhóm đã cấu hình) thay vì danh bạ trực tiếp từ nhà cung cấp.
- Đầu ra mặc định là `id` (và đôi khi `name`) được phân tách bằng tab; dùng `--json` cho mục đích scripting.

## Sử dụng kết quả với `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## Định dạng ID (theo kênh)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (nhóm)
- Telegram: `@username` hoặc id chat dạng số; nhóm là id dạng số
- Slack: `user:U…` và `channel:C…`
- Discord: `user:<id>` và `channel:<id>`
- Matrix (plugin): `user:@user:server`, `room:!roomId:server` hoặc `#alias:server`
- Microsoft Teams (plugin): `user:<id>` và `conversation:<id>`
- Zalo (plugin): user id (Bot API)
- Zalo Personal / `zalouser` (plugin): thread id (DM/nhóm) từ `zca` (`me`, `friend list`, `group list`)

## Self (“tôi”)

```bash
openclaw directory self --channel zalouser
```

## Peers (liên hệ/người dùng)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups (nhóm)

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
