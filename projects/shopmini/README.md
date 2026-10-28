# ShopMini — Demo quản lý bán hàng

ShopMini là bản demo frontend học tập dành cho shop nhỏ, đặt trong thư mục riêng của fork OpenClaw.

## Chức năng

- Dashboard: doanh thu từ đơn đã giao, tổng đơn, đơn đang xử lý, số sản phẩm và ước tính lợi nhuận gộp / giá trị tồn kho.
- Sản phẩm: thêm, tìm kiếm, theo dõi giá bán, giá vốn và tồn kho; ngăn xóa sản phẩm đã có đơn hàng liên quan.
- Đơn hàng: tạo đơn, kiểm tra tồn kho, tìm kiếm/lọc trạng thái, cập nhật trạng thái, hủy đơn và hoàn hàng vào kho.
- Kho hàng: nhập hoặc điều chỉnh tồn kho, không cho số lượng tồn âm, xem lịch sử thay đổi.
- Khách hàng: tổng hợp khách mua, số đơn và chi tiêu đã giao; tìm kiếm theo tên.
- Báo cáo: doanh thu, giá vốn hàng đã giao, lợi nhuận gộp ước tính, giá trị tồn kho.
- Xuất CSV: danh sách đơn hàng và khách hàng.
- Lưu dữ liệu trong localStorage; giao diện responsive và không cần thư viện bên ngoài.

## Chạy trên VS Code

1. Mở thư mục \`projects/shopmini\` trong VS Code.
2. Mở \`index.html\` trong trình duyệt hoặc dùng tiện ích Live Server.
3. Dùng dữ liệu demo để thử các luồng sản phẩm, đơn hàng, nhập kho và báo cáo.

## Giới hạn

Đây là demo frontend. Dữ liệu chỉ được lưu trong trình duyệt hiện tại, không đồng bộ giữa nhiều máy. Chưa có backend/database dùng chung, đăng nhập/phân quyền bảo mật, sao lưu máy chủ, hóa đơn điện tử, tích hợp vận chuyển, thanh toán trực tuyến, kết nối sàn thương mại điện tử, thông báo SMS/email hoặc chatbot AI thực sự. Báo cáo lợi nhuận là ước tính đơn giản, chưa trừ chi phí vận hành và thuế. Không sử dụng bản demo này để lưu dữ liệu khách hàng thật hoặc thay thế phần mềm kế toán.

## Vị trí

Nhánh \`feature/shopmini-mvp\`, thư mục \`projects/shopmini/\`. Nhánh \`main\` không bị chỉnh sửa.
