<div align="center">

# 🛍️ ShopMini

### Website quản lý bán hàng mini tích hợp trợ lý OpenClaw AI

Quản lý sản phẩm · Đơn hàng · Kho hàng · Khách hàng · Báo cáo · Trò chuyện với AI

![HTML](https://img.shields.io/badge/HTML5-Structure-orange?style=flat-square)
![CSS](https://img.shields.io/badge/CSS3-Styles-blue?style=flat-square)
![JavaScript](https://img.shields.io/badge/JavaScript-Frontend-yellow?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-Local%20Server-green?style=flat-square)
![OpenClaw](https://img.shields.io/badge/AI-OpenClaw-purple?style=flat-square)

*Dự án học tập và demo quy trình quản lý cửa hàng nhỏ. Chưa phải hệ thống sẵn sàng xử lý dữ liệu kinh doanh thật.*

</div>

---

## 📌 Giới thiệu

**ShopMini** là ứng dụng web quản lý bán hàng được xây dựng bằng HTML, CSS và JavaScript, có máy chủ Node.js làm cầu nối tới **OpenClaw Gateway** để cung cấp trợ lý AI.

Dự án có hai chế độ AI:

- **Quản lý bán hàng:** nhận tin nhắn bằng ngôn ngữ tự nhiên, xác định yêu cầu ghi nhận sản phẩm đã bán hoặc thêm sản phẩm mới, sau đó cập nhật dữ liệu demo nếu thông tin đủ và hợp lệ.
- **Tư vấn khách hàng:** trả lời câu hỏi về sản phẩm và giá bán dựa trên danh mục được cung cấp cho AI.

AI không tự biết tình trạng cửa hàng nếu không được gửi dữ liệu hiện tại. Hệ thống cần OpenClaw Gateway đang chạy và được cấu hình đúng mới có thể phản hồi.

## ✨ Tính năng

### 📦 Quản lý sản phẩm và tồn kho
- Thêm và xem sản phẩm, giá bán, giá vốn và số lượng tồn.
- Theo dõi tồn kho và cảnh báo sản phẩm sắp hết.
- Ghi lại lịch sử điều chỉnh kho.

### 🧾 Quản lý đơn hàng
- Tạo đơn hàng theo sản phẩm, số lượng và khách hàng.
- Theo dõi trạng thái đơn hàng.
- Hỗ trợ cập nhật tồn kho theo nghiệp vụ của bản demo.
- Tìm kiếm và lọc thông tin đơn hàng.

### 👥 Khách hàng và báo cáo
- Tổng hợp thông tin khách hàng từ các đơn hàng.
- Theo dõi doanh thu, giá vốn, lợi nhuận gộp ước tính và giá trị hàng tồn.
- Xuất dữ liệu được hỗ trợ ra tệp CSV.

### 🤖 Trợ lý OpenClaw AI
- Nhận yêu cầu quản lý bằng tiếng Việt.
- Có thể đề xuất hành động ghi nhận bán hàng hoặc thêm sản phẩm dựa trên nội dung người dùng cung cấp.
- Kiểm tra mã sản phẩm, số lượng tồn và dữ liệu bắt buộc trước khi áp dụng hành động.
- Có chế độ tư vấn riêng, sử dụng thông tin sản phẩm công khai.
- Gọi AI qua máy chủ Node.js; Gateway token không được đặt trong mã JavaScript phía trình duyệt.

> **Lưu ý:** AI có thể hiểu sai ngôn ngữ tự nhiên. Hãy kiểm tra phản hồi và đối chiếu đơn hàng/tồn kho sau mỗi thao tác. Chỉ dùng dữ liệu giả khi thử nghiệm.

## 🧰 Công nghệ

| Công nghệ | Vai trò |
|---|---|
| HTML5 | Cấu trúc giao diện |
| CSS3 | Bố cục và giao diện |
| JavaScript | Xử lý tương tác và nghiệp vụ phía trình duyệt |
| Node.js | Máy chủ cục bộ và API trung gian |
| OpenClaw Gateway | Cung cấp khả năng trò chuyện AI |
| localStorage | Lưu dữ liệu demo trong trình duyệt |
| CSV | Xuất dữ liệu để mở bằng phần mềm bảng tính |

## 📁 Cấu trúc thư mục

```text
projects/shopmini/
├── index.html       # Giao diện quản lý bán hàng và trợ lý AI
├── style.css        # Kiểu dáng website
├── app.js           # Logic giao diện, đơn hàng, kho và AI
├── server.mjs       # Máy chủ Node.js và cầu nối OpenClaw Gateway
├── package.json     # Lệnh khởi chạy máy chủ
├── .env.example     # Mẫu cấu hình kết nối
├── .gitignore       # Bỏ qua file bí mật .env
└── README.md        # Tài liệu dự án
```

## ⚙️ Cài đặt và chạy

### 1. Yêu cầu

- Git
- Node.js phiên bản 20 trở lên
- OpenClaw đã được cài đặt và Gateway đang chạy
- Gateway token hợp lệ và model được cấu hình trong OpenClaw

### 2. Tải dự án

Nếu chưa có mã nguồn trên máy, mở Terminal hoặc Git Bash và chạy:

```bash
git clone -b feature/shopmini-mvp https://github.com/phamminhquan012572-ui/openclaw.git
cd openclaw/projects/shopmini
```

Nếu đã clone repository trước đó:

```bash
git switch feature/shopmini-mvp
git pull origin feature/shopmini-mvp
cd projects/shopmini
```

### 3. Bật endpoint Chat Completions của OpenClaw

ShopMini gọi API tương thích OpenAI tại `/v1/chat/completions`. Trong cấu hình Gateway của OpenClaw, bật endpoint này:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

Lưu cấu hình và khởi động lại Gateway theo hướng dẫn của OpenClaw. Endpoint Chat Completions có thể bị tắt mặc định. Tham khảo [tài liệu API HTTP của OpenClaw](https://github.com/openclaw/openclaw/blob/main/docs/gateway/openai-http-api.md).

### 4. Thiết lập biến môi trường

Trong thư mục `projects/shopmini`, sao chép file mẫu:

Windows Command Prompt:

```bat
copy .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Mở `.env` và điền thông tin phù hợp với Gateway của bạn:

```dotenv
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789/v1/chat/completions
OPENCLAW_MODEL=openclaw/default
OPENCLAW_GATEWAY_TOKEN=YOUR_GATEWAY_TOKEN
SHOPMINI_PORT=4173
```

- `OPENCLAW_GATEWAY_URL`: địa chỉ endpoint Chat Completions.
- `OPENCLAW_MODEL`: tên model/định tuyến model mà Gateway của bạn chấp nhận.
- `OPENCLAW_GATEWAY_TOKEN`: token xác thực của Gateway.
- `SHOPMINI_PORT`: cổng chạy website, mặc định là `4173`.

Các giá trị trên là mẫu. Hãy dùng đúng địa chỉ, token và model trong môi trường OpenClaw của bạn.

### 5. Khởi động ShopMini

Trong Terminal, tại thư mục `projects/shopmini`, chạy:

```bash
npm start
```

Khi máy chủ khởi động, mở trình duyệt tại:

**http://127.0.0.1:4173**

Không mở `index.html` trực tiếp bằng trình duyệt nếu muốn dùng AI; tính năng chat gọi API `/api/assistant` trên máy chủ Node.js.

## 💬 Ví dụ sử dụng trợ lý AI

### Chế độ Quản lý bán hàng

- “Tôi vừa bán 2 Bình giữ nhiệt cho khách Minh Anh.”
- “Thêm sản phẩm Chuột không dây, giá bán 150000 đồng, tồn kho ban đầu 20.”

AI cần xác định được sản phẩm và thông tin bắt buộc. Nếu thiếu dữ liệu, sản phẩm không khớp hoặc tồn kho không đủ, hãy bổ sung thông tin thay vì cố ghi nhận giao dịch. Sau khi AI đề xuất hành động, ứng dụng mới kiểm tra và áp dụng hành động thuộc phạm vi được hỗ trợ.

### Chế độ Tư vấn khách hàng

- “Shop có những sản phẩm nào?”
- “Sản phẩm này có giá bao nhiêu?”
- “Tôi nên chọn sản phẩm nào trong danh mục?”

Câu trả lời phụ thuộc vào danh mục được gửi đến AI. Không xem câu trả lời AI là bằng chứng về tồn kho thực tế hoặc xác nhận đơn hàng đã được thanh toán.

## 🔐 Bảo mật quan trọng

- **Không commit file `.env` lên GitHub.** File này đã được thêm vào `.gitignore`; chỉ commit `.env.example` không chứa token thật.
- Không đặt Gateway token trong `app.js`, HTML hoặc bất kỳ mã nào gửi xuống trình duyệt.
- Gateway token có thể cấp quyền nhạy cảm. Chỉ sử dụng token phù hợp, giữ Gateway trên máy cá nhân hoặc mạng tin cậy và không mở trực tiếp cổng Gateway ra Internet.
- Máy chủ mẫu chỉ lắng nghe trên `127.0.0.1`, phù hợp để thử nghiệm cục bộ, không phải cấu hình triển khai công khai.
- Không đưa dữ liệu cá nhân nhạy cảm, thông tin thanh toán hoặc dữ liệu kinh doanh thật vào bản demo.
- Kiểm tra lại các cập nhật do AI đề xuất trước khi dựa vào chúng để ra quyết định.

## ⚠️ Giới hạn hiện tại

- Dữ liệu nghiệp vụ vẫn lưu trong `localStorage` của từng trình duyệt, chưa có cơ sở dữ liệu dùng chung hoặc đồng bộ nhiều thiết bị.
- Chưa có đăng nhập, phân quyền người dùng, sao lưu dữ liệu hoặc nhật ký kiểm toán phía máy chủ.
- Tích hợp AI cần OpenClaw Gateway, endpoint được bật, token hợp lệ và model khả dụng.
- Bản demo chưa được xác nhận qua kiểm thử triển khai thực tế; cần kiểm tra luồng AI, lỗi mạng, dữ liệu nhập và các trường hợp AI hiểu nhầm trước khi sử dụng.
- Không thay thế phần mềm bán hàng chuyên nghiệp, hệ thống kế toán hoặc hệ thống thanh toán.

## 🛣️ Lộ trình phát triển

- [x] Xây dựng giao diện quản lý sản phẩm, đơn hàng, kho và báo cáo.
- [x] Bổ sung giao diện chat với hai chế độ AI.
- [x] Tạo máy chủ Node.js làm cầu nối OpenClaw Gateway.
- [ ] Kiểm thử tự động các hành động AI và tình huống lỗi.
- [ ] Xây dựng backend và cơ sở dữ liệu dùng chung.
- [ ] Thêm đăng nhập, phân quyền và nhật ký thao tác.
- [ ] Bổ sung sao lưu, khôi phục dữ liệu và triển khai an toàn.
- [ ] Hoàn thiện kiểm thử trên điện thoại và máy tính bảng.

## 🤝 Đóng góp

Bạn có thể fork repository, tạo nhánh riêng, thực hiện thay đổi và gửi Pull Request. Khi báo lỗi, hãy nêu các bước tái hiện, kết quả mong đợi và kết quả thực tế. Không đính kèm token, file `.env` hoặc dữ liệu khách hàng thật.

## 📄 Giấy phép

Hãy kiểm tra file giấy phép ở thư mục gốc repository trước khi phân phối hoặc sử dụng lại dự án. README này không tự xác lập giấy phép mới cho mã nguồn.

---

<div align="center">

**ShopMini — Quản lý đơn giản hơn, thử nghiệm AI có trách nhiệm hơn.**

<sub>Thư mục: `projects/shopmini` · Nhánh: `feature/shopmini-mvp`</sub>

</div>
