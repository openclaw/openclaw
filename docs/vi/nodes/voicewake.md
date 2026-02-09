---
summary: "Từ đánh thức bằng giọng nói toàn cục (do Gateway sở hữu) và cách chúng đồng bộ trên các node"
read_when:
  - Thay đổi hành vi hoặc giá trị mặc định của từ đánh thức bằng giọng nói
  - Thêm các nền tảng node mới cần đồng bộ từ đánh thức
title: "Voice Wake"
---

# Voice Wake (Từ đánh thức toàn cục)

OpenClaw coi **từ đánh thức là một danh sách toàn cục duy nhất** do **Gateway** sở hữu.

- **Không có từ đánh thức tùy chỉnh theo từng node**.
- **Bất kỳ UI node/ứng dụng nào cũng có thể chỉnh sửa** danh sách; các thay đổi được Gateway lưu lại và phát tới mọi nơi.
- Mỗi thiết bị vẫn giữ công tắc **Bật/Tắt Voice Wake** riêng (UX cục bộ + quyền hạn khác nhau).

## Lưu trữ (máy chủ gateway)

Từ đánh thức được lưu trên máy gateway tại:

- `~/.openclaw/settings/voicewake.json`

Dạng dữ liệu:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Giao thức

### Phương thức

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` với tham số `{ triggers: string[] }` → `{ triggers: string[] }`

Ghi chú:

- 2. Các trigger được chuẩn hóa (cắt khoảng trắng, loại bỏ giá trị rỗng). 3. Danh sách rỗng sẽ quay về giá trị mặc định.
- Có áp dụng giới hạn để đảm bảo an toàn (giới hạn số lượng/độ dài).

### Sự kiện

- `voicewake.changed` payload `{ triggers: string[] }`

Ai nhận được:

- Tất cả client WebSocket (ứng dụng macOS, WebChat, v.v.)
- Tất cả các node đã kết nối (iOS/Android), và cũng được gửi khi node kết nối như một lần đẩy “trạng thái hiện tại” ban đầu.

## Hành vi phía client

### Ứng dụng macOS

- Sử dụng danh sách toàn cục để kiểm soát các trigger `VoiceWakeRuntime`.
- Chỉnh sửa “Trigger words” trong cài đặt Voice Wake sẽ gọi `voicewake.set` và sau đó dựa vào broadcast để giữ các client khác đồng bộ.

### Node iOS

- Sử dụng danh sách toàn cục cho việc phát hiện trigger `VoiceWakeManager`.
- Chỉnh sửa Wake Words trong Settings sẽ gọi `voicewake.set` (qua Gateway WS) và đồng thời giữ cho việc phát hiện từ đánh thức cục bộ luôn phản hồi nhanh.

### Node Android

- Cung cấp trình chỉnh sửa Wake Words trong Settings.
- Gọi `voicewake.set` qua Gateway WS để các chỉnh sửa được đồng bộ ở mọi nơi.
