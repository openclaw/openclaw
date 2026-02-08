---
summary: "Vòng đời lớp phủ giọng nói khi từ đánh thức và nhấn‑để‑nói chồng lấp"
read_when:
  - Điều chỉnh hành vi lớp phủ giọng nói
title: "Lớp phủ giọng nói"
x-i18n:
  source_path: platforms/mac/voice-overlay.md
  source_hash: 5d32704c412295c2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:48Z
---

# Vòng đời Lớp phủ Giọng nói (macOS)

Đối tượng: những người đóng góp cho ứng dụng macOS. Mục tiêu: giữ cho lớp phủ giọng nói có hành vi dự đoán được khi từ đánh thức và nhấn‑để‑nói chồng lấp.

## Ý định hiện tại

- Nếu lớp phủ đã hiển thị từ từ đánh thức và người dùng nhấn phím nóng, phiên phím nóng sẽ _kế thừa_ văn bản hiện có thay vì đặt lại. Lớp phủ vẫn hiển thị trong khi phím nóng được giữ. Khi người dùng thả ra: gửi nếu có văn bản đã được cắt gọn, nếu không thì đóng.
- Chỉ dùng từ đánh thức vẫn tự động gửi khi im lặng; nhấn‑để‑nói gửi ngay khi thả.

## Đã triển khai (9 Thg 12, 2025)

- Các phiên lớp phủ hiện mang theo một token cho mỗi lần thu (từ đánh thức hoặc nhấn‑để‑nói). Các cập nhật partial/final/send/dismiss/level sẽ bị bỏ khi token không khớp, tránh callback cũ.
- Nhấn‑để‑nói kế thừa mọi văn bản lớp phủ đang hiển thị làm tiền tố (vì vậy nhấn phím nóng khi lớp phủ từ đánh thức đang mở sẽ giữ văn bản và nối thêm lời nói mới). Nó chờ tối đa 1,5 giây để có bản chép cuối cùng trước khi quay về văn bản hiện tại.
- Ghi log chuông/lớp phủ được phát tại `info` trong các danh mục `voicewake.overlay`, `voicewake.ptt` và `voicewake.chime` (bắt đầu phiên, partial, final, send, dismiss, lý do chuông).

## Bước tiếp theo

1. **VoiceSessionCoordinator (actor)**
   - Sở hữu đúng một `VoiceSession` tại một thời điểm.
   - API (dựa trên token): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Bỏ các callback mang token cũ (ngăn các bộ nhận dạng cũ mở lại lớp phủ).
2. **VoiceSession (model)**
   - Trường: `token`, `source` (wakeWord|pushToTalk), văn bản committed/volatile, cờ chuông, bộ hẹn giờ (tự động gửi, nhàn rỗi), `overlayMode` (display|editing|sending), thời hạn cooldown.
3. **Liên kết lớp phủ**
   - `VoiceSessionPublisher` (`ObservableObject`) phản chiếu phiên đang hoạt động vào SwiftUI.
   - `VoiceWakeOverlayView` chỉ render thông qua publisher; không bao giờ thay đổi trực tiếp các singleton toàn cục.
   - Các hành động người dùng trên lớp phủ (`sendNow`, `dismiss`, `edit`) gọi ngược vào coordinator với token của phiên.
4. **Luồng gửi hợp nhất**
   - Khi `endCapture`: nếu văn bản đã cắt gọn rỗng → đóng; nếu không thì `performSend(session:)` (phát chuông gửi một lần, chuyển tiếp, đóng).
   - Nhấn‑để‑nói: không trì hoãn; từ đánh thức: có thể trì hoãn để tự động gửi.
   - Áp dụng một cooldown ngắn cho runtime từ đánh thức sau khi nhấn‑để‑nói kết thúc để từ đánh thức không kích hoạt lại ngay.
5. **Ghi log**
   - Coordinator phát log `.info` trong subsystem `bot.molt`, các danh mục `voicewake.overlay` và `voicewake.chime`.
   - Các sự kiện chính: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Danh sách kiểm tra gỡ lỗi

- Stream log trong khi tái hiện lớp phủ bị “dính”:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Xác minh chỉ có một token phiên đang hoạt động; các callback cũ phải bị coordinator bỏ.
- Đảm bảo việc thả nhấn‑để‑nói luôn gọi `endCapture` với token đang hoạt động; nếu văn bản rỗng, kỳ vọng `dismiss` mà không có chuông hoặc gửi.

## Các bước di chuyển (đề xuất)

1. Thêm `VoiceSessionCoordinator`, `VoiceSession` và `VoiceSessionPublisher`.
2. Tái cấu trúc `VoiceWakeRuntime` để tạo/cập nhật/kết thúc phiên thay vì chạm trực tiếp vào `VoiceWakeOverlayController`.
3. Tái cấu trúc `VoicePushToTalk` để kế thừa các phiên hiện có và gọi `endCapture` khi thả; áp dụng cooldown runtime.
4. Kết nối `VoiceWakeOverlayController` với publisher; loại bỏ các lời gọi trực tiếp từ runtime/PTT.
5. Thêm các bài kiểm thử tích hợp cho việc kế thừa phiên, cooldown và đóng khi văn bản rỗng.
