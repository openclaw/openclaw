<div align="center">

# 🛍️ ShopMini

### Hệ thống quản lý bán hàng dành cho cửa hàng nhỏ

**Quản lý sản phẩm · Theo dõi đơn hàng · Kiểm soát kho · Phân tích kinh doanh**

<p>
  <img src="https://img.shields.io/badge/Project-Frontend%20Demo-2563eb?style=for-the-badge" alt="Frontend Demo">
  <img src="https://img.shields.io/badge/Language-HTML%20%7C%20CSS%20%7C%20JavaScript-f59e0b?style=for-the-badge" alt="HTML CSS JavaScript">
  <img src="https://img.shields.io/badge/Database-localStorage-16a34a?style=for-the-badge" alt="localStorage">
  <img src="https://img.shields.io/badge/Status-Learning%20Project-7c3aed?style=for-the-badge" alt="Learning Project">
</p>

*Giao diện demo phục vụ học tập và thử nghiệm quy trình quản lý một cửa hàng nhỏ.*

</div>

---

## 📑 Mục lục

- [✨ Giới thiệu](#-giới-thiệu)
- [🚀 Tính năng](#-tính-năng)
- [🖥️ Công nghệ sử dụng](#️-công-nghệ-sử-dụng)
- [⚙️ Cài đặt và chạy thử](#️-cài-đặt-và-chạy-thử)
- [🧭 Hướng dẫn sử dụng](#-hướng-dẫn-sử-dụng)
- [📊 Cách tính báo cáo](#-cách-tính-báo-cáo)
- [📁 Cấu trúc thư mục](#-cấu-trúc-thư-mục)
- [⚠️ Giới hạn hiện tại](#️-giới-hạn-hiện-tại)
- [🛣️ Lộ trình phát triển](#️-lộ-trình-phát-triển)
- [🤝 Đóng góp](#-đóng-góp)

## ✨ Giới thiệu

**ShopMini** là dự án giao diện quản lý bán hàng đơn giản, được xây dựng để thực hành phát triển web bằng HTML, CSS và JavaScript thuần. Dự án hướng đến các nghiệp vụ thường gặp ở một cửa hàng nhỏ: quản lý danh mục sản phẩm, tạo và theo dõi đơn hàng, điều chỉnh số lượng tồn kho, xem thông tin khách hàng và xuất báo cáo.

> **Lưu ý:** ShopMini hiện là bản demo frontend. Dữ liệu được lưu trong bộ nhớ cục bộ của trình duyệt, chưa có máy chủ hoặc cơ sở dữ liệu dùng chung.

## 🚀 Tính năng

### 📈 Tổng quan kinh doanh
- Theo dõi doanh thu của các đơn hàng đã giao.
- Xem tổng số đơn, số đơn đang xử lý và số lượng sản phẩm.
- Xem ước tính lợi nhuận gộp và giá trị tồn kho theo giá vốn.

### 📦 Quản lý sản phẩm
- Thêm sản phẩm với tên, giá bán và số lượng ban đầu.
- Theo dõi giá bán, giá vốn và tồn kho.
- Hiển thị cảnh báo khi hàng sắp hết hoặc đã hết.
- Hạn chế xóa sản phẩm có đơn hàng liên quan.

### 🧾 Quản lý đơn hàng
- Tạo đơn hàng theo sản phẩm, số lượng và tên khách hàng.
- Kiểm tra số lượng tồn trước khi tạo đơn.
- Tìm kiếm đơn và lọc theo trạng thái.
- Cập nhật trạng thái đơn hàng.
- Hủy đơn và hoàn số lượng sản phẩm về kho.

### 🏬 Quản lý kho
- Nhập thêm hoặc điều chỉnh tồn kho.
- Không cho phép tồn kho xuống dưới 0.
- Ghi chú lý do điều chỉnh và xem lịch sử thay đổi kho.

### 👥 Quản lý thông tin khách hàng
- Tổng hợp khách hàng xuất hiện trong các đơn.
- Thống kê số đơn và tổng chi tiêu của đơn đã giao.
- Tìm kiếm khách hàng theo tên.

### 📊 Báo cáo và xuất dữ liệu
- Xem doanh thu, giá vốn hàng đã giao và lợi nhuận gộp ước tính.
- Xem giá trị hàng tồn theo giá vốn.
- Xuất danh sách đơn hàng và dữ liệu khách hàng thành tệp CSV để mở bằng Excel hoặc phần mềm bảng tính tương thích.

### 💾 Lưu trữ trên trình duyệt
- Lưu dữ liệu bằng \`localStorage\`.
- Không cần cài đặt thư viện JavaScript bên ngoài để chạy bản demo.
- Dữ liệu demo phù hợp để thử nghiệm các thao tác cơ bản.

## 🖥️ Công nghệ sử dụng

| Công nghệ | Vai trò |
|---|---|
| **HTML5** | Xây dựng cấu trúc trang |
| **CSS3** | Tạo kiểu giao diện và bố cục |
| **JavaScript** | Xử lý nghiệp vụ và tương tác |
| **localStorage** | Lưu dữ liệu trong trình duyệt |
| **CSV** | Xuất dữ liệu để xem và xử lý bằng bảng tính |
| **Visual Studio Code** | Môi trường chỉnh sửa mã nguồn được khuyến nghị |

## ⚙️ Cài đặt và chạy thử

### Cách 1 — Tải mã nguồn bằng Git

Mở Terminal hoặc Git Bash và chạy:

\`\`\`bash
git clone -b feature/shopmini-mvp https://github.com/phamminhquan012572-ui/openclaw.git
cd openclaw/projects/shopmini
\`\`\`

Sau đó mở thư mục \`projects/shopmini\` bằng VS Code.

### Cách 2 — Nếu đã fork dự án

Nếu bạn đã có bản sao repository trên máy, hãy chuyển sang đúng nhánh và cập nhật mã nguồn:

\`\`\`bash
git switch feature/shopmini-mvp
git pull origin feature/shopmini-mvp
\`\`\`

> Nếu nhánh trên máy chưa được tạo, chạy \`git fetch origin\` rồi \`git switch --track origin/feature/shopmini-mvp\`.

### Mở website

1. Mở thư mục \`projects/shopmini\` trong VS Code.
2. Tìm file \`index.html\`.
3. Mở file bằng trình duyệt hoặc sử dụng tiện ích **Live Server** trong VS Code.
4. Thử thêm sản phẩm, tạo đơn hàng, điều chỉnh tồn kho và xuất CSV.

Không cần XAMPP hoặc lệnh \`npm install\` cho phiên bản frontend tĩnh hiện tại.

## 🧭 Hướng dẫn sử dụng

1. **Kiểm tra sản phẩm:** đảm bảo danh sách sản phẩm đã hiển thị.
2. **Thêm sản phẩm:** nhập thông tin sản phẩm và số lượng ban đầu.
3. **Tạo đơn:** chọn sản phẩm, nhập tên khách hàng và số lượng phù hợp với tồn kho.
4. **Xử lý đơn:** tìm đơn hàng, cập nhật trạng thái hoặc hủy khi cần.
5. **Điều chỉnh kho:** chọn sản phẩm, nhập số lượng thay đổi và ghi rõ lý do.
6. **Xem khách hàng và báo cáo:** kiểm tra số đơn, chi tiêu, doanh thu và các chỉ số ước tính.
7. **Xuất CSV:** tải dữ liệu ra tệp để xem hoặc xử lý bằng bảng tính.

## 📊 Cách tính báo cáo

- **Doanh thu:** tổng giá trị đơn có trạng thái **Đã giao**.
- **Giá vốn hàng đã giao:** tổng giá vốn lưu trong đơn nhân số lượng đã giao.
- **Lợi nhuận gộp ước tính:** doanh thu trừ giá vốn hàng đã giao.
- **Giá trị tồn kho:** số lượng hiện có nhân giá vốn sản phẩm.
- **Chi tiêu khách hàng:** tổng giá trị các đơn đã giao của khách hàng đó.

Các chỉ số trên chỉ phục vụ minh họa. Lợi nhuận chưa trừ tiền thuê mặt bằng, lương, phí vận chuyển, thuế, hoàn tiền và các chi phí khác. Cần kiểm thử dữ liệu và nghiệp vụ trước khi sử dụng trong hoạt động kinh doanh thực tế.

## 📁 Cấu trúc thư mục

\`\`\`text
openclaw/
└── projects/
    └── shopmini/
        ├── index.html    # Cấu trúc giao diện
        ├── style.css     # Kiểu dáng giao diện
        ├── app.js        # Nghiệp vụ và tương tác
        └── README.md     # Tài liệu dự án
\`\`\`

## ⚠️ Giới hạn hiện tại

ShopMini chưa phải hệ thống quản lý bán hàng hoàn chỉnh để triển khai kinh doanh thực tế.

- Dữ liệu chỉ nằm trong trình duyệt hiện tại; không tự đồng bộ giữa thiết bị hoặc người dùng.
- Chưa có đăng nhập, phân quyền, máy chủ hoặc cơ sở dữ liệu trung tâm.
- Chưa có quản lý nhà cung cấp, phiếu nhập hàng đầy đủ, công nợ và chi phí vận hành.
- Chưa tích hợp thanh toán trực tuyến, hóa đơn điện tử, vận chuyển hoặc sàn thương mại điện tử.
- Chưa có chatbot AI kết nối với dữ liệu cửa hàng.
- Dữ liệu trong trình duyệt có thể bị mất khi người dùng xóa dữ liệu website; nên chỉ dùng dữ liệu giả để thử nghiệm.

**Không lưu thông tin thanh toán hoặc dữ liệu cá nhân nhạy cảm của khách hàng trong bản demo này.**

## 🛣️ Lộ trình phát triển

- [ ] Hoàn thiện giao diện trên điện thoại và máy tính bảng.
- [ ] Bổ sung chỉnh sửa sản phẩm và hồ sơ khách hàng.
- [ ] Bổ sung nhà cung cấp, phiếu nhập kho và chi phí.
- [ ] Xây dựng backend và cơ sở dữ liệu dùng chung.
- [ ] Thêm đăng nhập và phân quyền theo vai trò.
- [ ] Hoàn thiện kiểm thử, xác thực dữ liệu và sao lưu.
- [ ] Nghiên cứu chatbot hỗ trợ khách hàng và báo cáo nâng cao.
- [ ] Triển khai bản thử nghiệm lên hosting sau khi hoàn thiện các yêu cầu bảo mật.

## 🤝 Đóng góp

Bạn có thể fork repository, tạo nhánh riêng, thực hiện thay đổi và gửi Pull Request. Khi báo lỗi, hãy mô tả các bước tái hiện, kết quả mong đợi và kết quả thực tế; không đính kèm dữ liệu khách hàng thật hoặc thông tin bí mật.

## 📄 Giấy phép

Hãy kiểm tra file giấy phép ở thư mục gốc repository trước khi phân phối hoặc sử dụng lại dự án. README này không tự xác lập giấy phép mới cho mã nguồn.

---

<div align="center">

**ShopMini — Học tập hôm nay, phát triển sản phẩm tốt hơn ngày mai.**

<sub>Thư mục dự án: \`projects/shopmini\` · Nhánh: \`feature/shopmini-mvp\`</sub>

</div>
