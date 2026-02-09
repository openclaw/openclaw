---
summary: "Xử lý sự cố nhanh ở cấp độ kênh với các dấu hiệu lỗi theo từng kênh và cách khắc phục"
read_when:
  - Kênh vận chuyển báo đã kết nối nhưng phản hồi thất bại
  - Bạn cần các kiểm tra theo từng kênh trước khi đọc tài liệu chuyên sâu của nhà cung cấp
title: "Xử lý sự cố kênh"
---

# Xử lý sự cố kênh

Dùng trang này khi một kênh kết nối được nhưng hành vi không đúng.

## Thang lệnh

Chạy theo thứ tự trước tiên:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Đường cơ sở lành mạnh:

- `Runtime: running`
- `RPC probe: ok`
- Thăm dò kênh hiển thị đã kết nối/sẵn sàng

## WhatsApp

### Dấu hiệu lỗi WhatsApp

| Triệu chứng                            | Kiểm tra nhanh nhất                                     | Cách khắc phục                                                                |
| -------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Đã kết nối nhưng không trả lời DM      | `openclaw pairing list whatsapp`                        | Phê duyệt người gửi hoặc chuyển chính sách/allowlist DM.      |
| Tin nhắn nhóm bị bỏ qua                | Kiểm tra `requireMention` + mẫu nhắc đến trong cấu hình | Nhắc đến bot hoặc nới lỏng chính sách nhắc đến cho nhóm đó.   |
| Ngắt kết nối/nghỉ đăng nhập ngẫu nhiên | `openclaw channels status --probe` + nhật ký            | Đăng nhập lại và xác minh thư mục thông tin xác thực còn tốt. |

Xử lý sự cố đầy đủ: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Dấu hiệu lỗi Telegram

| Triệu chứng                                      | Kiểm tra nhanh nhất                                  | Cách khắc phục                                                           |
| ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `/start` nhưng không có luồng phản hồi dùng được | `openclaw pairing list telegram`                     | Phê duyệt ghép cặp hoặc thay đổi chính sách DM.          |
| Bot online nhưng nhóm im lặng                    | Xác minh yêu cầu nhắc đến và chế độ riêng tư của bot | Tắt chế độ riêng tư để nhóm thấy được hoặc nhắc đến bot. |
| Gửi thất bại với lỗi mạng                        | Kiểm tra nhật ký lỗi gọi API Telegram                | Sửa định tuyến DNS/IPv6/proxy tới `api.telegram.org`.    |

Xử lý sự cố đầy đủ: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Dấu hiệu lỗi Discord

| Triệu chứng                                | Kiểm tra nhanh nhất                               | Cách khắc phục                                                                |
| ------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| Bot online nhưng không trả lời trong guild | `openclaw channels status --probe`                | Cho phép guild/kênh và xác minh intent nội dung tin nhắn.     |
| Tin nhắn nhóm bị bỏ qua                    | Kiểm tra nhật ký các lần chặn do yêu cầu nhắc đến | Nhắc đến bot hoặc đặt `requireMention: false` cho guild/kênh. |
| Thiếu phản hồi DM                          | `openclaw pairing list discord`                   | Phê duyệt ghép cặp DM hoặc điều chỉnh chính sách DM.          |

Xử lý sự cố đầy đủ: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Dấu hiệu lỗi Slack

| Triệu chứng                                    | Kiểm tra nhanh nhất                      | Cách khắc phục                                                         |
| ---------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| Socket mode đã kết nối nhưng không có phản hồi | `openclaw channels status --probe`       | Xác minh app token + bot token và các scope cần thiết. |
| DMs bị chặn                                    | `openclaw pairing list slack`            | Phê duyệt ghép cặp hoặc nới lỏng chính sách DM.        |
| Tin nhắn kênh bị bỏ qua                        | Kiểm tra `groupPolicy` và allowlist kênh | Cho phép kênh hoặc chuyển chính sách sang `open`.      |

Xử lý sự cố đầy đủ: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage và BlueBubbles

### Dấu hiệu lỗi iMessage và BlueBubbles

| Triệu chứng                          | Kiểm tra nhanh nhất                                                       | Cách khắc phục                                                       |
| ------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Không có sự kiện vào                 | Xác minh khả năng truy cập webhook/máy chủ và quyền ứng dụng              | Sửa URL webhook hoặc trạng thái máy chủ BlueBubbles. |
| Gửi được nhưng không nhận trên macOS | Kiểm tra quyền riêng tư macOS cho tự động hóa Messages                    | Cấp lại quyền TCC và khởi động lại tiến trình kênh.  |
| Người gửi DM bị chặn                 | `openclaw pairing list imessage` hoặc `openclaw pairing list bluebubbles` | Phê duyệt ghép cặp hoặc cập nhật allowlist.          |

Xử lý sự cố đầy đủ:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Dấu hiệu lỗi Signal

| Triệu chứng                            | Kiểm tra nhanh nhất                     | Cách khắc phục                                                             |
| -------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| Daemon truy cập được nhưng bot im lặng | `openclaw channels status --probe`      | Xác minh URL/tài khoản daemon `signal-cli` và chế độ nhận. |
| DM bị chặn                             | `openclaw pairing list signal`          | Phê duyệt người gửi hoặc điều chỉnh chính sách DM.         |
| Phản hồi nhóm không kích hoạt          | Kiểm tra allowlist nhóm và mẫu nhắc đến | Thêm người gửi/nhóm hoặc nới lỏng cơ chế chặn.             |

Xử lý sự cố đầy đủ: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Dấu hiệu lỗi Matrix

| Triệu chứng                              | Kiểm tra nhanh nhất                      | Cách khắc phục                                                     |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Đã đăng nhập nhưng bỏ qua tin nhắn phòng | `openclaw channels status --probe`       | Kiểm tra `groupPolicy` và allowlist phòng.         |
| DM không được xử lý                      | `openclaw pairing list matrix`           | Phê duyệt người gửi hoặc điều chỉnh chính sách DM. |
| Phòng mã hóa thất bại                    | Xác minh mô-đun crypto và cài đặt mã hóa | Bật hỗ trợ mã hóa và tham gia lại/đồng bộ phòng.   |

Xử lý sự cố đầy đủ: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
