---
summary: "Chạy OpenClaw trong một VM macOS dạng sandbox (cục bộ hoặc được host) khi bạn cần cách ly hoặc iMessage"
read_when:
  - Bạn muốn OpenClaw được cách ly khỏi môi trường macOS chính
  - Bạn muốn tích hợp iMessage (BlueBubbles) trong một sandbox
  - Bạn muốn một môi trường macOS có thể đặt lại và sao chép
  - Bạn muốn so sánh các lựa chọn VM macOS cục bộ và được host
title: "VM macOS"
---

# OpenClaw trên VM macOS (Sandboxing)

## Mặc định được khuyến nghị (đa số người dùng)

- **Small Linux VPS** for an always-on Gateway and low cost. See [VPS hosting](/vps).
- **Phần cứng chuyên dụng** (Mac mini hoặc máy Linux) nếu bạn muốn toàn quyền kiểm soát và một **IP dân dụng** cho tự động hóa trình duyệt. Nhiều trang web chặn IP trung tâm dữ liệu, vì vậy duyệt web từ máy cục bộ thường hoạt động tốt hơn.
- **Hybrid:** keep the Gateway on a cheap VPS, and connect your Mac as a **node** when you need browser/UI automation. See [Nodes](/nodes) and [Gateway remote](/gateway/remote).

Chỉ dùng VM macOS khi bạn thực sự cần các khả năng chỉ có trên macOS (iMessage/BlueBubbles) hoặc muốn cách ly nghiêm ngặt khỏi chiếc Mac dùng hằng ngày.

## Các tùy chọn VM macOS

### VM cục bộ trên Mac Apple Silicon của bạn (Lume)

Chạy OpenClaw trong một VM macOS dạng sandbox trên Mac Apple Silicon hiện có bằng [Lume](https://cua.ai/docs/lume).

Bạn sẽ có:

- Môi trường macOS đầy đủ và cách ly (máy chủ của bạn luôn sạch)
- Hỗ trợ iMessage qua BlueBubbles (không thể trên Linux/Windows)
- Đặt lại tức thì bằng cách sao chép VM
- Không cần phần cứng bổ sung hay chi phí đám mây

### Nhà cung cấp Mac được host (đám mây)

Nếu bạn muốn macOS trên đám mây, các nhà cung cấp Mac được host cũng phù hợp:

- [MacStadium](https://www.macstadium.com/) (Mac được host)
- Các nhà cung cấp Mac khác cũng hoạt động; làm theo tài liệu VM + SSH của họ

Khi đã có quyền truy cập SSH vào VM macOS, tiếp tục từ bước 6 bên dưới.

---

## Lộ trình nhanh (Lume, người dùng có kinh nghiệm)

1. Cài đặt Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Hoàn tất Setup Assistant, bật Remote Login (SSH)
4. `lume run openclaw --no-display`
5. SSH vào, cài OpenClaw, cấu hình các kênh
6. Xong

---

## Những gì bạn cần (Lume)

- Mac Apple Silicon (M1/M2/M3/M4)
- macOS Sequoia hoặc mới hơn trên máy chủ
- ~60 GB dung lượng trống cho mỗi VM
- ~20 phút

---

## 1. Cài đặt Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Nếu `~/.local/bin` chưa có trong PATH của bạn:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Xác minh:

```bash
lume --version
```

Tài liệu: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Tạo VM macOS

```bash
lume create openclaw --os macos --ipsw latest
```

Thao tác này tải macOS và tạo VM. A VNC window opens automatically.

Lưu ý: Việc tải có thể mất thời gian tùy thuộc vào kết nối của bạn.

---

## 3. Hoàn tất Setup Assistant

Trong cửa sổ VNC:

1. Chọn ngôn ngữ và khu vực
2. Bỏ qua Apple ID (hoặc đăng nhập nếu bạn muốn iMessage sau này)
3. Tạo tài khoản người dùng (ghi nhớ tên đăng nhập và mật khẩu)
4. Bỏ qua tất cả các tính năng tùy chọn

Sau khi hoàn tất, bật SSH:

1. Mở System Settings → General → Sharing
2. Bật "Remote Login"

---

## 4. Lấy địa chỉ IP của VM

```bash
lume get openclaw
```

Tìm địa chỉ IP (thường là `192.168.64.x`).

---

## 5. SSH vào VM

```bash
ssh youruser@192.168.64.X
```

Thay `youruser` bằng tài khoản bạn đã tạo, và IP bằng IP của VM.

---

## 6. Cài đặt OpenClaw

Bên trong VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Làm theo các bước hướng dẫn ban đầu để thiết lập nhà cung cấp mô hình của bạn (Anthropic, OpenAI, v.v.).

---

## 7. Cấu hình các kênh

Chỉnh sửa tệp cấu hình:

```bash
nano ~/.openclaw/openclaw.json
```

Thêm các kênh của bạn:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Sau đó đăng nhập WhatsApp (quét QR):

```bash
openclaw channels login
```

---

## 8. Chạy VM không giao diện

Dừng VM và khởi động lại không có màn hình:

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM chạy trong nền. OpenClaw's daemon keeps the gateway running.

Để kiểm tra trạng thái:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Phần thưởng: tích hợp iMessage

This is the killer feature of running on macOS. Use [BlueBubbles](https://bluebubbles.app) to add iMessage to OpenClaw.

Bên trong VM:

1. Tải BlueBubbles từ bluebubbles.app
2. Đăng nhập bằng Apple ID của bạn
3. Bật Web API và đặt mật khẩu
4. Trỏ webhook của BlueBubbles về gateway của bạn (ví dụ: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Thêm vào cấu hình OpenClaw của bạn:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Khởi động lại gateway. Now your agent can send and receive iMessages.

Chi tiết thiết lập đầy đủ: [BlueBubbles channel](/channels/bluebubbles)

---

## Lưu một golden image

Trước khi tùy biến thêm, hãy chụp snapshot trạng thái sạch:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Đặt lại bất cứ lúc nào:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Chạy 24/7

Giữ VM chạy bằng cách:

- Cắm nguồn cho Mac
- Tắt chế độ ngủ trong System Settings → Energy Saver
- Dùng `caffeinate` nếu cần

Để luôn luôn hoạt động thực sự, hãy cân nhắc một Mac mini chuyên dụng hoặc một VPS nhỏ. See [VPS hosting](/vps).

---

## Xử lý sự cố

| Vấn đề                      | Giải pháp                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Không SSH vào VM được       | Kiểm tra "Remote Login" đã được bật trong System Settings của VM                                               |
| Không thấy IP của VM        | Chờ VM khởi động hoàn tất, chạy lại `lume get openclaw`                                                        |
| Không tìm thấy lệnh Lume    | Thêm `~/.local/bin` vào PATH của bạn                                                                           |
| Không quét được QR WhatsApp | Đảm bảo bạn đang đăng nhập trong VM (không phải máy chủ) khi chạy `openclaw channels login` |

---

## Tài liệu liên quan

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (nâng cao)
- [Docker Sandboxing](/install/docker) (cách cách ly thay thế)
