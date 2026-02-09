---
summary: "Các trạng thái và hoạt ảnh của biểu tượng thanh menu cho OpenClaw trên macOS"
read_when:
  - Thay đổi hành vi biểu tượng thanh menu
title: "Biểu tượng thanh menu"
---

# Các trạng thái biểu tượng thanh menu

Tác giả: steipete · Cập nhật: 2025-12-06 · Phạm vi: ứng dụng macOS (`apps/macos`)

- **Nhàn rỗi:** Hoạt ảnh biểu tượng bình thường (chớp mắt, thỉnh thoảng lắc nhẹ).
- **Tạm dừng:** Mục trạng thái sử dụng `appearsDisabled`; không chuyển động.
- **Kích hoạt bằng giọng nói (tai lớn):** Bộ phát hiện từ đánh thức gọi `AppState.triggerVoiceEars(ttl: nil)` khi nghe thấy từ đánh thức, giữ `earBoostActive=true` trong khi thu thập lời nói. Ears scale up (1.9x), get circular ear holes for readability, then drop via `stopVoiceEars()` after 1s of silence. Chỉ được kích hoạt từ pipeline giọng nói trong ứng dụng.
- **Đang làm việc (agent đang chạy):** `AppState.isWorking=true` điều khiển một vi chuyển động “đuôi/chân chạy”: chân lắc nhanh hơn và lệch nhẹ trong khi công việc đang diễn ra. Currently toggled around WebChat agent runs; add the same toggle around other long tasks when you wire them.

Các điểm kết nối

- Đánh thức bằng giọng nói: runtime/tester gọi `AppState.triggerVoiceEars(ttl: nil)` khi kích hoạt và `stopVoiceEars()` sau 1 giây im lặng để khớp với cửa sổ thu nhận.
- Hoạt động của agent: đặt `AppStateStore.shared.setWorking(true/false)` bao quanh các khoảng làm việc (đã thực hiện trong lời gọi agent WebChat). Giữ các khoảng ngắn và reset trong các khối `defer` để tránh animation bị kẹt.

Hình dạng & kích thước

- Biểu tượng gốc được vẽ trong `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Tỷ lệ tai mặc định là `1.0`; tăng cường giọng nói đặt `earScale=1.9` và bật/tắt `earHoles=true` mà không thay đổi khung tổng thể (ảnh mẫu 18×18 pt được render vào bộ nhớ nền Retina 36×36 px).
- Chuyển động chạy lăng xăng dùng lắc chân lên đến ~1.0 kèm rung ngang nhỏ; nó được cộng thêm vào bất kỳ lắc nhàn rỗi hiện có nào.

Ghi chú hành vi

- Không có công tắc CLI/broker bên ngoài cho tai/đang làm việc; giữ nó nội bộ theo các tín hiệu của chính ứng dụng để tránh vẫy lung tung ngoài ý muốn.
- Giữ TTL ngắn (&lt;10s) để biểu tượng nhanh chóng quay về trạng thái cơ bản nếu một tác vụ bị treo.
