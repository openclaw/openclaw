---
title: Xác minh hình thức (Mô hình bảo mật)
summary: Các mô hình bảo mật được kiểm chứng bằng máy cho những luồng rủi ro cao nhất của OpenClaw.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:26Z
---

# Xác minh hình thức (Mô hình bảo mật)

Trang này theo dõi các **mô hình bảo mật hình thức** của OpenClaw (hiện tại là TLA+/TLC; sẽ bổ sung khi cần).

> Lưu ý: một số liên kết cũ có thể tham chiếu tên dự án trước đây.

**Mục tiêu (north star):** cung cấp một lập luận được kiểm chứng bằng máy rằng OpenClaw thực thi
chính sách bảo mật dự định của mình (ủy quyền, cô lập phiên, kiểm soát công cụ, và
an toàn trước cấu hình sai), dưới các giả định được nêu rõ.

**Hiện tại, đây là:** một **bộ hồi quy bảo mật** có thể thực thi, theo góc nhìn của kẻ tấn công:

- Mỗi khẳng định đều có một lần kiểm tra mô hình có thể chạy trên không gian trạng thái hữu hạn.
- Nhiều khẳng định có **mô hình âm** đi kèm, tạo ra vết truy ngược phản ví dụ cho một lớp lỗi thực tế.

**Chưa phải (hiện tại):** một chứng minh rằng “OpenClaw an toàn trong mọi khía cạnh” hoặc rằng toàn bộ triển khai TypeScript là đúng.

## Nơi lưu trữ các mô hình

Các mô hình được duy trì trong một repo riêng: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Các lưu ý quan trọng

- Đây là **mô hình**, không phải toàn bộ triển khai TypeScript. Có thể xảy ra độ lệch giữa mô hình và mã.
- Kết quả bị giới hạn bởi không gian trạng thái mà TLC khám phá; “xanh” không ngụ ý an toàn vượt ra ngoài các giả định và giới hạn đã mô hình hóa.
- Một số khẳng định dựa trên các giả định môi trường tường minh (ví dụ: triển khai đúng, đầu vào cấu hình đúng).

## Tái tạo kết quả

Hiện nay, kết quả được tái tạo bằng cách clone repo mô hình về máy cục bộ và chạy TLC (xem bên dưới). Một phiên bản trong tương lai có thể cung cấp:

- Các mô hình chạy qua CI với artifact công khai (vết phản ví dụ, log chạy)
- Quy trình “chạy mô hình này” được lưu trữ cho các kiểm tra nhỏ, có giới hạn

Bắt đầu:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Phơi bày Gateway và cấu hình sai gateway mở

**Khẳng định:** bind vượt quá loopback mà không có xác thực có thể cho phép xâm nhập từ xa / làm tăng bề mặt phơi bày; token/mật khẩu chặn kẻ tấn công không được ủy quyền (theo các giả định của mô hình).

- Chạy xanh:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Đỏ (kỳ vọng):
  - `make gateway-exposure-v2-negative`

Xem thêm: `docs/gateway-exposure-matrix.md` trong repo mô hình.

### Pipeline Nodes.run (năng lực rủi ro cao nhất)

**Khẳng định:** `nodes.run` yêu cầu (a) danh sách cho phép lệnh node cùng với các lệnh đã khai báo và (b) phê duyệt trực tiếp khi được cấu hình; các phê duyệt được token hóa để ngăn phát lại (trong mô hình).

- Chạy xanh:
  - `make nodes-pipeline`
  - `make approvals-token`
- Đỏ (kỳ vọng):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Kho ghép cặp (DM gating)

**Khẳng định:** các yêu cầu ghép cặp tuân thủ TTL và giới hạn số yêu cầu đang chờ.

- Chạy xanh:
  - `make pairing`
  - `make pairing-cap`
- Đỏ (kỳ vọng):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Kiểm soát ingress (mentions + né kiểm soát bằng lệnh điều khiển)

**Khẳng định:** trong bối cảnh nhóm yêu cầu mention, một “lệnh điều khiển” không được ủy quyền không thể né kiểm soát mention.

- Xanh:
  - `make ingress-gating`
- Đỏ (kỳ vọng):
  - `make ingress-gating-negative`

### Định tuyến / cô lập khóa phiên

**Khẳng định:** DM từ các peer khác nhau không bị gộp vào cùng một phiên trừ khi được liên kết/cấu hình một cách tường minh.

- Xanh:
  - `make routing-isolation`
- Đỏ (kỳ vọng):
  - `make routing-isolation-negative`

## v1++: các mô hình có giới hạn bổ sung (đồng thời, retry, tính đúng đắn của trace)

Đây là các mô hình tiếp nối nhằm tăng độ trung thực quanh các chế độ lỗi ngoài đời thực (cập nhật không nguyên tử, retry, và fan-out thông điệp).

### Đồng thời / tính bất biến idempotent của kho ghép cặp

**Khẳng định:** kho ghép cặp phải thực thi `MaxPending` và tính idempotent ngay cả dưới các xen kẽ (tức là “kiểm tra rồi ghi” phải nguyên tử / có khóa; làm mới không được tạo bản sao).

Ý nghĩa:

- Dưới các yêu cầu đồng thời, không thể vượt quá `MaxPending` cho một kênh.
- Các yêu cầu/làm mới lặp lại cho cùng `(channel, sender)` không được tạo ra các dòng pending đang hoạt động trùng lặp.

- Chạy xanh:
  - `make pairing-race` (kiểm tra giới hạn nguyên tử/có khóa)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Đỏ (kỳ vọng):
  - `make pairing-race-negative` (race giới hạn begin/commit không nguyên tử)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Tương quan trace ingress / tính idempotent

**Khẳng định:** quá trình ingestion phải bảo toàn tương quan trace qua fan-out và là idempotent trước các retry của nhà cung cấp.

Ý nghĩa:

- Khi một sự kiện bên ngoài trở thành nhiều thông điệp nội bộ, mọi phần đều giữ cùng danh tính trace/sự kiện.
- Retry không dẫn đến xử lý trùng lặp.
- Nếu thiếu ID sự kiện từ nhà cung cấp, khử trùng lặp sẽ quay về khóa an toàn (ví dụ: trace ID) để tránh loại bỏ các sự kiện khác nhau.

- Xanh:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Đỏ (kỳ vọng):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Định tuyến: ưu tiên dmScope + identityLinks

**Khẳng định:** định tuyến phải giữ các phiên DM được cô lập theo mặc định, và chỉ gộp phiên khi được cấu hình tường minh (ưu tiên theo kênh + liên kết danh tính).

Ý nghĩa:

- Các override dmScope theo kênh phải thắng các mặc định toàn cục.
- identityLinks chỉ nên gộp trong các nhóm được liên kết tường minh, không gộp giữa các peer không liên quan.

- Xanh:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Đỏ (kỳ vọng):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
