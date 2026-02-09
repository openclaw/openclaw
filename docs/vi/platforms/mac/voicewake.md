---
summary: "Các chế độ kích hoạt bằng giọng nói và nhấn-để-nói cùng chi tiết định tuyến trong ứng dụng mac"
read_when:
  - Làm việc trên các luồng Voice Wake hoặc PTT
title: "Voice Wake"
---

# Voice Wake & Nhấn-để-nói

## Chế độ

- **Wake-word mode** (default): always-on Speech recognizer waits for trigger tokens (`swabbleTriggerWords`). On match it starts capture, shows the overlay with partial text, and auto-sends after silence.
- **Push-to-talk (Right Option hold)**: hold the right Option key to capture immediately—no trigger needed. The overlay appears while held; releasing finalizes and forwards after a short delay so you can tweak text.

## Hành vi thời gian chạy (từ đánh thức)

- Trình nhận dạng giọng nói chạy trong `VoiceWakeRuntime`.
- Trigger only fires when there’s a **meaningful pause** between the wake word and the next word (~0.55s gap). The overlay/chime can start on the pause even before the command begins.
- Cửa sổ im lặng: 2,0s khi đang nói liên tục, 5,0s nếu chỉ nghe thấy từ kích hoạt.
- Dừng cứng: 120s để ngăn phiên chạy quá lâu.
- Chống dội giữa các phiên: 350ms.
- Overlay được điều khiển qua `VoiceWakeOverlayController` với màu sắc cho trạng thái đã xác nhận/tạm thời.
- Sau khi gửi, trình nhận dạng khởi động lại sạch sẽ để lắng nghe lần kích hoạt tiếp theo.

## Bất biến vòng đời

- Nếu Voice Wake được bật và đã cấp quyền, trình nhận dạng từ đánh thức phải luôn lắng nghe (trừ khi đang có một phiên nhấn-để-nói rõ ràng).
- Trạng thái hiển thị của overlay (bao gồm việc đóng thủ công bằng nút X) không bao giờ được ngăn trình nhận dạng tiếp tục hoạt động.

## Lỗi overlay bị “dính” (trước đây)

Trước đây, nếu overlay bị kẹt hiển thị và bạn đóng thủ công, Voice Wake có thể trông như “chết” vì nỗ lực khởi động lại của runtime có thể bị chặn bởi trạng thái hiển thị của overlay và không có lần khởi động lại tiếp theo được lên lịch.

Gia cố:

- Việc khởi động lại runtime của wake không còn bị chặn bởi trạng thái hiển thị overlay.
- Hoàn tất thao tác đóng overlay sẽ kích hoạt `VoiceWakeRuntime.refresh(...)` qua `VoiceSessionCoordinator`, nên việc đóng bằng nút X luôn tiếp tục lắng nghe.

## Chi tiết nhấn-để-nói

- Phát hiện phím nóng sử dụng một monitor toàn cục `.flagsChanged` cho **Option phải** (`keyCode 61` + `.option`). We only observe events (no swallowing).
- Pipeline thu âm nằm trong `VoicePushToTalk`: bắt đầu Speech ngay, stream các phần tạm thời lên overlay và gọi `VoiceWakeForwarder` khi thả phím.
- Khi nhấn-để-nói bắt đầu, chúng tôi tạm dừng runtime từ đánh thức để tránh xung đột các tap âm thanh; nó sẽ tự động khởi động lại sau khi thả phím.
- Quyền: cần Microphone + Speech; để nhận sự kiện cần phê duyệt Accessibility/Input Monitoring.
- Bàn phím ngoài: một số loại có thể không hiển thị Option phải như mong đợi—hãy cung cấp phím tắt dự phòng nếu người dùng báo bị bỏ sót.

## Cài đặt cho người dùng

- **Voice Wake**: bật runtime từ đánh thức.
- **Hold Cmd+Fn to talk**: enables the push-to-talk monitor. Disabled on macOS < 26.
- Bộ chọn ngôn ngữ & mic, đồng hồ mức âm trực tiếp, bảng từ kích hoạt, trình kiểm thử (chỉ cục bộ; không chuyển tiếp).
- Bộ chọn mic giữ lại lựa chọn cuối cùng nếu thiết bị ngắt kết nối, hiển thị gợi ý đã ngắt và tạm thời chuyển sang mặc định hệ thống cho đến khi thiết bị quay lại.
- **Sounds**: chimes on trigger detect and on send; defaults to the macOS “Glass” system sound. You can pick any `NSSound`-loadable file (e.g. MP3/WAV/AIFF) for each event or choose **No Sound**.

## Hành vi chuyển tiếp

- Khi Voice Wake được bật, bản chép lời sẽ được chuyển tiếp tới gateway/tác tử đang hoạt động (cùng chế độ cục bộ vs từ xa như phần còn lại của ứng dụng mac).
- Replies are delivered to the **last-used main provider** (WhatsApp/Telegram/Discord/WebChat). If delivery fails, the error is logged and the run is still visible via WebChat/session logs.

## Payload chuyển tiếp

- `VoiceWakeForwarder.prefixedTranscript(_:)` prepends the machine hint before sending. Shared between wake-word and push-to-talk paths.

## Xác minh nhanh

- Bật nhấn-để-nói, giữ Cmd+Fn, nói, thả: overlay phải hiển thị các phần tạm thời rồi gửi.
- Trong lúc giữ, biểu tượng tai ở thanh menu phải được phóng to (dùng `triggerVoiceEars(ttl:nil)`); thả phím thì trở lại bình thường.
