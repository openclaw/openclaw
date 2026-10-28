# ShopMini — Demo quản lý shop nhỏ

ShopMini là bản demo học tập để quản lý sản phẩm, đơn hàng và doanh thu cơ bản. Dự án được đặt trong thư mục riêng của fork OpenClaw để không can thiệp vào mã nguồn chính của OpenClaw.

## Chức năng hiện có

- Bảng tổng quan: doanh thu từ đơn đã giao, tổng số đơn, đơn đang xử lý và số sản phẩm.
- Quản lý sản phẩm: thêm sản phẩm, xem giá/tồn kho và xóa sản phẩm khi không có đơn chưa hủy liên quan.
- Quản lý đơn hàng: tạo đơn, kiểm tra tồn kho, tìm kiếm, lọc trạng thái, chuyển trạng thái và hủy đơn.
- Tự tính tổng tiền và cập nhật số lượng tồn kho khi tạo hoặc hủy đơn.
- Lưu dữ liệu trong `localStorage` của trình duyệt.
- Giao diện responsive, không sử dụng thư viện bên ngoài.

## Cách chạy trong VS Code

1. Mở thư mục `projects/shopmini` trong VS Code hoặc mở file `index.html`.
2. Mở `index.html` bằng trình duyệt. Bạn cũng có thể dùng tiện ích Live Server trong VS Code nếu đã cài.
3. Thử tạo sản phẩm mới, tạo đơn hàng, tìm kiếm đơn và cập nhật trạng thái.
4. Để khôi phục dữ liệu mẫu, mở Developer Tools → Console và chạy:

```js
ShopMini.resetDemo()
```

Nếu trình duyệt chặn lưu trữ khi mở file trực tiếp, hãy chạy qua Live Server.

## Cấu trúc

- `index.html`: cấu trúc giao diện.
- `style.css`: giao diện và responsive.
- `app.js`: dữ liệu mẫu, xử lý đơn/sản phẩm và lưu localStorage.

## Phạm vi và giới hạn

Đây là **MVP frontend**, chưa tích hợp OpenClaw runtime, AI API, backend, database dùng chung, tài khoản, phân quyền, sao lưu máy chủ hay thanh toán. Dữ liệu chỉ nằm trong trình duyệt hiện tại; không dùng bản này để lưu thông tin khách hàng thật hoặc vận hành cửa hàng thật.

## Hướng phát triển tiếp theo

1. Viết backend và database (ví dụ Node.js + SQLite/PostgreSQL).
2. Thêm đăng nhập, phân quyền theo từng shop và kiểm tra dữ liệu ở server.
3. Bổ sung xuất CSV, báo cáo theo ngày/tháng và sao lưu.
4. Chỉ tích hợp OpenClaw như một lớp trợ lý tùy chọn sau khi xác định rõ tác vụ cần tự động hóa (ví dụ tổng hợp báo cáo hoặc trả lời câu hỏi về đơn hàng).

## Nơi lưu mã nguồn

Được lưu trong fork OpenClaw ở nhánh `feature/shopmini-mvp`, thư mục `projects/shopmini/`. Nhánh `main` không bị chỉnh sửa.
