---
summary: "Trạng thái hỗ trợ, khả năng và cấu hình ứng dụng Google Chat"
read_when:
  - Làm việc với các tính năng kênh Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

Trạng thái: sẵn sàng cho DM + spaces thông qua webhook Google Chat API (chỉ HTTP).

## Thiết lập nhanh (cho người mới)

1. Tạo một dự án Google Cloud và bật **Google Chat API**.
   - Truy cập: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Bật API nếu chưa được bật.
2. Tạo một **Service Account**:
   - Nhấn **Create Credentials** > **Service Account**.
   - Đặt tên tùy ý (ví dụ: `openclaw-chat`).
   - Để trống phần quyền (nhấn **Continue**).
   - Để trống phần principals có quyền truy cập (nhấn **Done**).
3. Tạo và tải xuống **JSON Key**:
   - Trong danh sách service accounts, nhấp vào account vừa tạo.
   - Vào tab **Keys**.
   - Nhấn **Add Key** > **Create new key**.
   - Chọn **JSON** và nhấn **Create**.
4. Lưu file JSON đã tải xuống trên máy chủ gateway của bạn (ví dụ: `~/.openclaw/googlechat-service-account.json`).
5. Tạo một ứng dụng Google Chat trong [Google Cloud Console Chat Configuration](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Điền **Application info**:
     - **App name**: (ví dụ: `OpenClaw`)
     - **Avatar URL**: (ví dụ: `https://openclaw.ai/logo.png`)
     - **Description**: (ví dụ: `Personal AI Assistant`)
   - Bật **Interactive features**.
   - Trong **Functionality**, chọn **Join spaces and group conversations**.
   - Trong **Connection settings**, chọn **HTTP endpoint URL**.
   - Trong **Triggers**, chọn **Use a common HTTP endpoint URL for all triggers** và đặt thành URL công khai của gateway, theo sau là `/googlechat`.
     - _Mẹo: Chạy `openclaw status` để tìm URL công khai của gateway._
   - Trong **Visibility**, chọn **Make this Chat app available to specific people and groups in &lt;Your Domain&gt;**.
   - Nhập địa chỉ email của bạn (ví dụ: `user@example.com`) vào ô văn bản.
   - Nhấn **Save** ở cuối trang.
6. **Bật trạng thái ứng dụng**:
   - Sau khi lưu, **tải lại trang**.
   - Tìm phần **App status** (thường ở gần đầu hoặc cuối trang sau khi lưu).
   - Đổi trạng thái thành **Live - available to users**.
   - Nhấn **Save** lần nữa.
7. Cấu hình OpenClaw với đường dẫn service account + webhook audience:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - Hoặc config: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Thiết lập loại + giá trị webhook audience (khớp với cấu hình ứng dụng Chat của bạn).
9. Khởi động gateway. Google Chat will POST to your webhook path.

## Thêm vào Google Chat

Khi gateway đang chạy và email của bạn đã được thêm vào danh sách hiển thị:

1. Truy cập [Google Chat](https://chat.google.com/).
2. Nhấp vào biểu tượng **+** (dấu cộng) bên cạnh **Direct Messages**.
3. Trong thanh tìm kiếm (nơi bạn thường thêm người), nhập **App name** đã cấu hình trong Google Cloud Console.
   - **Note**: The bot will _not_ appear in the "Marketplace" browse list because it is a private app. You must search for it by name.
4. Chọn bot của bạn từ kết quả.
5. Nhấn **Add** hoặc **Chat** để bắt đầu cuộc trò chuyện 1:1.
6. Gửi "Hello" để kích hoạt trợ lý!

## URL công khai (chỉ webhook)

Google Chat webhooks require a public HTTPS endpoint. Vì lý do bảo mật, **chỉ mở đường dẫn `/googlechat`** ra internet. Giữ bảng điều khiển OpenClaw và các endpoint nhạy cảm khác trong mạng riêng của bạn.

### Tùy chọn A: Tailscale Funnel (Khuyến nghị)

Use Tailscale Serve for the private dashboard and Funnel for the public webhook path. This keeps `/` private while exposing only `/googlechat`.

1. **Kiểm tra địa chỉ mà gateway đang bind tới:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Ghi chú địa chỉ IP (ví dụ: `127.0.0.1`, `0.0.0.0`, hoặc IP Tailscale của bạn như `100.x.x.x`).

2. **Chỉ công khai dashboard cho tailnet (cổng 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Chỉ công khai đường dẫn webhook:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Ủy quyền node cho quyền truy cập Funnel:**
   Nếu được nhắc, hãy truy cập URL ủy quyền hiển thị trong đầu ra để bật Funnel cho node này trong chính sách tailnet của bạn.

5. **Xác minh cấu hình:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

URL webhook công khai của bạn sẽ là:
`https://<node-name>.<tailnet>`.ts.net/googlechat\`

Your private dashboard stays tailnet-only:
`https://<node-name>.<tailnet>.ts.net:8443/`

Sử dụng URL công khai (không bao gồm `:8443`) trong cấu hình ứng dụng Google Chat.

> Lưu ý: Cấu hình này sẽ được giữ nguyên sau khi khởi động lại. To remove it later, run `tailscale funnel reset` and `tailscale serve reset`.

### Tùy chọn B: Reverse Proxy (Caddy)

Nếu bạn dùng reverse proxy như Caddy, chỉ proxy đường dẫn cụ thể:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Với cấu hình này, mọi request tới `your-domain.com/` sẽ bị bỏ qua hoặc trả về 404, trong khi `your-domain.com/googlechat` được định tuyến an toàn tới OpenClaw.

### Tùy chọn C: Cloudflare Tunnel

Cấu hình ingress rules của tunnel để chỉ định tuyến đường dẫn webhook:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Default Rule**: HTTP 404 (Not Found)

## Cách hoạt động

1. Google Chat gửi các POST webhook tới gateway. Each request includes an `Authorization: Bearer <token>` header.
2. OpenClaw xác minh token dựa trên `audienceType` + `audience` đã cấu hình:
   - `audienceType: "app-url"` → audience là URL webhook HTTPS của bạn.
   - `audienceType: "project-number"` → audience là số dự án Cloud.
3. Tin nhắn được định tuyến theo space:
   - DM dùng khóa phiên `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Spaces dùng khóa phiên `agent:<agentId>:googlechat:group:<spaceId>`.
4. DM access is pairing by default. Unknown senders receive a pairing code; approve with:
   - `openclaw pairing approve googlechat <code>`
5. Group spaces require @-mention by default. Use `botUser` if mention detection needs the app’s user name.

## Targets

Sử dụng các định danh sau cho việc gửi và allowlist:

- Tin nhắn trực tiếp: `users/<userId>` hoặc `users/<email>` (chấp nhận địa chỉ email).
- Spaces: `spaces/<spaceId>`.

## Điểm nổi bật về cấu hình

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Ghi chú:

- Thông tin xác thực service account cũng có thể truyền inline với `serviceAccount` (chuỗi JSON).
- Đường dẫn webhook mặc định là `/googlechat` nếu `webhookPath` chưa được thiết lập.
- Reactions khả dụng thông qua công cụ `reactions` và `channels action` khi `actions.reactions` được bật.
- `typingIndicator` hỗ trợ `none`, `message` (mặc định) và `reaction` (reaction yêu cầu OAuth người dùng).
- Tệp đính kèm được tải xuống thông qua Chat API và lưu trong media pipeline (kích thước bị giới hạn bởi `mediaMaxMb`).

## Xử lý sự cố

### 405 Method Not Allowed

Nếu Google Cloud Logs Explorer hiển thị lỗi như:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

This means the webhook handler isn't registered. Group system prompt: ở lượt đầu tiên của một phiên nhóm (và bất cứ khi nào `/activation` thay đổi chế độ), chúng tôi chèn một đoạn mô tả ngắn vào system prompt như `You are replying inside the WhatsApp group "<subject>"`.

1. **Channel not configured**: The `channels.googlechat` section is missing from your config. Xác minh bằng:

   ```bash
   openclaw config get channels.googlechat
   ```

   Nếu trả về "Config path not found", hãy thêm cấu hình (xem [Config highlights](#config-highlights)).

2. **Plugin chưa được bật**: Kiểm tra trạng thái plugin:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Nếu hiển thị "disabled", hãy thêm `plugins.entries.googlechat.enabled: true` vào config của bạn.

3. **Gateway chưa được khởi động lại**: Sau khi thêm config, hãy khởi động lại gateway:

   ```bash
   openclaw gateway restart
   ```

Xác minh kênh đang chạy:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Vấn đề khác

- Kiểm tra `openclaw channels status --probe` để tìm lỗi xác thực hoặc thiếu cấu hình audience.
- Nếu không có tin nhắn đến, hãy xác nhận URL webhook + đăng ký sự kiện của ứng dụng Chat.
- Nếu cơ chế chặn theo mention ngăn trả lời, hãy đặt `botUser` thành user resource name của ứng dụng và xác minh `requireMention`.
- Dùng `openclaw logs --follow` trong khi gửi tin nhắn thử để xem request có tới gateway hay không.

Tài liệu liên quan:

- [Gateway configuration](/gateway/configuration)
- [Security](/gateway/security)
- [Reactions](/tools/reactions)
