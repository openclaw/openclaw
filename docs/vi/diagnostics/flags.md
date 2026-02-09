---
summary: "Cờ chẩn đoán cho nhật ký debug có mục tiêu"
read_when:
  - Bạn cần nhật ký debug có mục tiêu mà không tăng mức ghi log toàn cục
  - Bạn cần thu thập nhật ký theo từng phân hệ để hỗ trợ
title: "Cờ chẩn đoán"
---

# Cờ chẩn đoán

Các cờ chẩn đoán cho phép bạn bật log debug có mục tiêu mà không cần bật verbose logging ở khắp nơi. Các cờ là opt-in và không có tác dụng trừ khi một subsystem kiểm tra chúng.

## Cách hoạt động

- Cờ là các chuỗi (không phân biệt hoa/thường).
- Bạn có thể bật cờ trong cấu hình hoặc thông qua ghi đè bằng biến môi trường.
- Hỗ trợ ký tự đại diện:
  - `telegram.*` khớp với `telegram.http`
  - `*` bật tất cả các cờ

## Bật qua cấu hình

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Nhiều cờ:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Khởi động lại gateway (cổng kết nối) sau khi thay đổi cờ.

## Ghi đè bằng biến môi trường (một lần)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Tắt tất cả cờ:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Nhật ký được ghi ở đâu

Các cờ ghi log vào file log chẩn đoán tiêu chuẩn. Theo mặc định:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Nếu bạn đặt `logging.file`, hãy dùng đường dẫn đó thay thế. Log ở dạng JSONL (mỗi dòng là một đối tượng JSON). Việc che dữ liệu vẫn áp dụng dựa trên `logging.redactSensitive`.

## Trích xuất nhật ký

Chọn tệp log mới nhất:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Lọc chẩn đoán HTTP của Telegram:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Hoặc theo dõi (tail) trong khi tái hiện lỗi:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Với gateway từ xa, bạn cũng có thể dùng `openclaw logs --follow` (xem [/cli/logs](/cli/logs)).

## Ghi chú

- Nếu `logging.level` được đặt cao hơn `warn`, các log này có thể bị ẩn. `info` mặc định là ổn.
- Có thể để cờ bật an toàn; chúng chỉ ảnh hưởng đến lượng log của phân hệ cụ thể.
- Dùng [/logging](/logging) để thay đổi đích đến log, mức log và che dữ liệu.
