---
summary: "Các chế độ kích hoạt bằng giọng nói và nhấn-để-nói cùng chi tiết định tuyến trong ứng dụng mac"
read_when:
  - Làm việc trên các luồng Voice Wake hoặc PTT
title: "Voice Wake"
x-i18n:
  source_path: platforms/mac/voicewake.md
  source_hash: f6440bb89f349ba5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:51Z
---

# Voice Wake & Nhấn-để-nói

## Chế độ

- **Chế độ từ đánh thức** (mặc định): trình nhận dạng giọng nói luôn bật chờ các token kích hoạt (`swabbleTriggerWords`). Khi khớp, hệ thống bắt đầu thu âm, hiển thị overlay với văn bản tạm thời và tự động gửi sau khi im lặng.
- **Nhấn-để-nói (giữ Option phải)**: giữ phím Option phải để thu âm ngay—không cần từ kích hoạt. Overlay xuất hiện trong lúc giữ; thả phím sẽ hoàn tất và chuyển tiếp sau một độ trễ ngắn để bạn có thể chỉnh văn bản.

## Hành vi thời gian chạy (từ đánh thức)

- Trình nhận dạng giọng nói chạy trong `VoiceWakeRuntime`.
- Kích hoạt chỉ xảy ra khi có **khoảng dừng có ý nghĩa** giữa từ đánh thức và từ tiếp theo (khoảng cách ~0,55s). Overlay/chuông có thể bắt đầu ngay tại khoảng dừng, thậm chí trước khi lệnh bắt đầu.
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

- Phát hiện phím nóng sử dụng bộ theo dõi toàn cục `.flagsChanged` cho **Option phải** (`keyCode 61` + `.option`). Chỉ quan sát sự kiện (không chặn).
- Pipeline thu âm nằm trong `VoicePushToTalk`: bắt đầu Speech ngay, stream các phần tạm thời lên overlay và gọi `VoiceWakeForwarder` khi thả phím.
- Khi nhấn-để-nói bắt đầu, chúng tôi tạm dừng runtime từ đánh thức để tránh xung đột các tap âm thanh; nó sẽ tự động khởi động lại sau khi thả phím.
- Quyền: cần Microphone + Speech; để nhận sự kiện cần phê duyệt Accessibility/Input Monitoring.
- Bàn phím ngoài: một số loại có thể không hiển thị Option phải như mong đợi—hãy cung cấp phím tắt dự phòng nếu người dùng báo bị bỏ sót.

## Cài đặt cho người dùng

- **Voice Wake**: bật runtime từ đánh thức.
- **Giữ Cmd+Fn để nói**: bật bộ theo dõi nhấn-để-nói. Bị vô hiệu trên macOS < 26.
- Bộ chọn ngôn ngữ & mic, đồng hồ mức âm trực tiếp, bảng từ kích hoạt, trình kiểm thử (chỉ cục bộ; không chuyển tiếp).
- Bộ chọn mic giữ lại lựa chọn cuối cùng nếu thiết bị ngắt kết nối, hiển thị gợi ý đã ngắt và tạm thời chuyển sang mặc định hệ thống cho đến khi thiết bị quay lại.
- **Âm thanh**: chuông khi phát hiện kích hoạt và khi gửi; mặc định là âm hệ thống macOS “Glass”. Bạn có thể chọn bất kỳ tệp có thể tải bằng `NSSound` (ví dụ MP3/WAV/AIFF) cho mỗi sự kiện hoặc chọn **Không âm thanh**.

## Hành vi chuyển tiếp

- Khi Voice Wake được bật, bản chép lời sẽ được chuyển tiếp tới gateway/tác tử đang hoạt động (cùng chế độ cục bộ vs từ xa như phần còn lại của ứng dụng mac).
- Phản hồi được gửi tới **nhà cung cấp chính được dùng gần nhất** (WhatsApp/Telegram/Discord/WebChat). Nếu gửi thất bại, lỗi sẽ được ghi log và lần chạy vẫn hiển thị qua WebChat/log phiên.

## Payload chuyển tiếp

- `VoiceWakeForwarder.prefixedTranscript(_:)` thêm gợi ý máy vào trước khi gửi. Dùng chung cho cả luồng từ đánh thức và nhấn-để-nói.

## Xác minh nhanh

- Bật nhấn-để-nói, giữ Cmd+Fn, nói, thả: overlay phải hiển thị các phần tạm thời rồi gửi.
- Trong lúc giữ, biểu tượng tai ở thanh menu phải được phóng to (dùng `triggerVoiceEars(ttl:nil)`); thả phím thì trở lại bình thường.
