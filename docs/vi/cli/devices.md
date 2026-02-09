---
summary: "Tham chiếu CLI cho `openclaw devices` (ghép cặp thiết bị + xoay vòng/thu hồi token)"
read_when:
  - Bạn đang phê duyệt yêu cầu ghép cặp thiết bị
  - Bạn cần xoay vòng hoặc thu hồi token thiết bị
title: "devices"
---

# `openclaw devices`

Quản lý các yêu cầu ghép cặp thiết bị và token theo phạm vi thiết bị.

## Commands

### `openclaw devices list`

Liệt kê các yêu cầu ghép cặp đang chờ và các thiết bị đã được ghép cặp.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Phê duyệt một yêu cầu ghép cặp thiết bị đang chờ.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Từ chối một yêu cầu ghép cặp thiết bị đang chờ.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Xoay vòng token thiết bị cho một vai trò cụ thể (tùy chọn cập nhật phạm vi).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Thu hồi token thiết bị cho một vai trò cụ thể.

```
openclaw devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: URL WebSocket của Gateway (mặc định là `gateway.remote.url` khi đã cấu hình).
- `--token <token>`: Token của Gateway (nếu cần).
- `--password <password>`: Mật khẩu Gateway (xác thực bằng mật khẩu).
- `--timeout <ms>`: Thời gian chờ RPC.
- `--json`: Đầu ra JSON (khuyến nghị cho scripting).

Lưu ý: khi bạn đặt `--url`, CLI không tự động dùng thông tin xác thực từ cấu hình hoặc môi trường.
Hãy truyền `--token` hoặc `--password` một cách tường minh. Thiếu thông tin xác thực tường minh là một lỗi.

## Notes

- Xoay vòng token trả về một token mới (nhạy cảm). Hãy coi nó như một bí mật.
- Các lệnh này yêu cầu phạm vi `operator.pairing` (hoặc `operator.admin`).
