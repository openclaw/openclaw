---
summary: "Các trạng thái và hoạt ảnh của biểu tượng thanh menu cho OpenClaw trên macOS"
read_when:
  - Thay đổi hành vi biểu tượng thanh menu
title: "Biểu tượng thanh menu"
x-i18n:
  source_path: platforms/mac/icon.md
  source_hash: a67a6e6bbdc2b611
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:41Z
---

# Các trạng thái biểu tượng thanh menu

Tác giả: steipete · Cập nhật: 2025-12-06 · Phạm vi: ứng dụng macOS (`apps/macos`)

- **Nhàn rỗi:** Hoạt ảnh biểu tượng bình thường (chớp mắt, thỉnh thoảng lắc nhẹ).
- **Tạm dừng:** Mục trạng thái sử dụng `appearsDisabled`; không chuyển động.
- **Kích hoạt bằng giọng nói (tai lớn):** Trình phát hiện đánh thức bằng giọng nói gọi `AppState.triggerVoiceEars(ttl: nil)` khi nghe thấy từ đánh thức, giữ `earBoostActive=true` trong khi thu nhận phát ngôn. Tai phóng to (1,9x), có lỗ tai hình tròn để dễ đọc, sau đó hạ xuống qua `stopVoiceEars()` sau 1 giây im lặng. Chỉ được kích hoạt từ pipeline giọng nói trong ứng dụng.
- **Đang làm việc (tác tử đang chạy):** `AppState.isWorking=true` điều khiển vi chuyển động “chạy lăng xăng đuôi/chân”: lắc chân nhanh hơn và lệch nhẹ khi công việc đang diễn ra. Hiện được bật/tắt quanh các lần chạy tác tử WebChat; hãy thêm cùng cơ chế bật/tắt này cho các tác vụ dài khác khi bạn kết nối chúng.

Các điểm kết nối

- Đánh thức bằng giọng nói: runtime/tester gọi `AppState.triggerVoiceEars(ttl: nil)` khi kích hoạt và `stopVoiceEars()` sau 1 giây im lặng để khớp với cửa sổ thu nhận.
- Hoạt động của tác tử: đặt `AppStateStore.shared.setWorking(true/false)` quanh các khoảng công việc (đã làm trong lệnh gọi tác tử WebChat). Giữ các khoảng này ngắn và đặt lại trong các khối `defer` để tránh hoạt ảnh bị kẹt.

Hình dạng & kích thước

- Biểu tượng gốc được vẽ trong `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Tỷ lệ tai mặc định là `1.0`; tăng cường giọng nói đặt `earScale=1.9` và bật/tắt `earHoles=true` mà không thay đổi khung tổng thể (ảnh mẫu 18×18 pt được render vào bộ nhớ nền Retina 36×36 px).
- Chuyển động chạy lăng xăng dùng lắc chân lên đến ~1.0 kèm rung ngang nhỏ; nó được cộng thêm vào bất kỳ lắc nhàn rỗi hiện có nào.

Ghi chú hành vi

- Không có công tắc CLI/broker bên ngoài cho tai/đang làm việc; giữ nó nội bộ theo các tín hiệu của chính ứng dụng để tránh vẫy lung tung ngoài ý muốn.
- Giữ TTL ngắn (&lt;10s) để biểu tượng nhanh chóng quay về trạng thái cơ bản nếu một tác vụ bị treo.
