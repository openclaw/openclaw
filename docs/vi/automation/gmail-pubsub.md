---
summary: "Gmail Pub/Sub push được nối vào webhook OpenClaw qua gogcli"
read_when:
  - Kết nối các trigger hộp thư Gmail với OpenClaw
  - Thiết lập Pub/Sub push để đánh thức tác tử
title: "Gmail PubSub"
---

# Gmail Pub/Sub -> OpenClaw

Mục tiêu: Gmail watch -> Pub/Sub push -> `gog gmail watch serve` -> webhook OpenClaw.

## Prereqs

- `gcloud` đã được cài đặt và đăng nhập ([hướng dẫn cài đặt](https://docs.cloud.google.com/sdk/docs/install-sdk)).
- `gog` (gogcli) đã được cài đặt và ủy quyền cho tài khoản Gmail ([gogcli.sh](https://gogcli.sh/)).
- Đã bật hook OpenClaw (xem [Webhooks](/automation/webhook)).
- `tailscale` đã đăng nhập ([tailscale.com](https://tailscale.com/)). Cấu hình được hỗ trợ sử dụng Tailscale Funnel cho endpoint HTTPS công khai.
  Các dịch vụ đường hầm khác có thể hoạt động, nhưng là DIY/không được hỗ trợ và yêu cầu cấu hình thủ công.
  Hiện tại, Tailscale là thứ chúng tôi hỗ trợ.

Ví dụ cấu hình hook (bật ánh xạ preset Gmail):

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

Để gửi bản tóm tắt Gmail tới một bề mặt chat, hãy ghi đè preset bằng một ánh xạ
thiết lập `deliver` + tùy chọn `channel`/`to`:

```json5
{
  hooks: {
    enabled: true,
    token: "OPENCLAW_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        model: "openai/gpt-5.2-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

Nếu bạn muốn một kênh cố định, hãy đặt `channel` + `to`. Nếu không, `channel: "last"`
sẽ dùng tuyến gửi gần nhất (fallback về WhatsApp).

Để buộc dùng model rẻ hơn cho các lần chạy Gmail, hãy đặt `model` trong mapping
(`provider/model` hoặc alias). Nếu bạn áp dụng `agents.defaults.models`, hãy bao gồm nó ở đó.

Để đặt mô hình mặc định và mức độ suy nghĩ riêng cho hook Gmail, thêm
`hooks.gmail.model` / `hooks.gmail.thinking` trong cấu hình của bạn:

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

Ghi chú:

- `model`/`thinking` theo từng hook trong ánh xạ vẫn ghi đè các giá trị mặc định này.
- Thứ tự fallback: `hooks.gmail.model` → `agents.defaults.model.fallbacks` → chính (xác thực/giới hạn tốc độ/timeout).
- Nếu đặt `agents.defaults.models`, mô hình Gmail phải nằm trong allowlist.
- 2. Nội dung hook Gmail mặc định được bọc trong các ranh giới an toàn cho external-content.
     Để vô hiệu hóa (nguy hiểm), hãy đặt `hooks.gmail.allowUnsafeExternalContent: true`.

Để tùy biến xử lý payload sâu hơn, thêm `hooks.mappings` hoặc một module transform JS/TS
dưới `hooks.transformsDir` (xem [Webhooks](/automation/webhook)).

## Wizard (khuyến nghị)

Dùng trợ giúp OpenClaw để nối mọi thứ với nhau (cài deps trên macOS qua brew):

```bash
openclaw webhooks gmail setup \
  --account openclaw@gmail.com
```

Mặc định:

- Dùng Tailscale Funnel cho endpoint push công khai.
- Ghi cấu hình `hooks.gmail` cho `openclaw webhooks gmail run`.
- Bật preset hook Gmail (`hooks.presets: ["gmail"]`).

Ghi chú về path: khi bật `tailscale.mode`, OpenClaw tự động đặt
`hooks.gmail.serve.path` thành `/` và giữ path công khai tại
`hooks.gmail.tailscale.path` (mặc định `/gmail-pubsub`) vì Tailscale
loại bỏ tiền tố set-path trước khi proxy.
3. Nếu bạn cần backend nhận được đường dẫn có tiền tố, hãy đặt `hooks.gmail.tailscale.target` (hoặc `--tailscale-target`) thành một URL đầy đủ như `http://127.0.0.1:8788/gmail-pubsub` và khớp với `hooks.gmail.serve.path`.

Muốn một endpoint tùy chỉnh? Sử dụng `--push-endpoint <url>` hoặc `--tailscale off`.

Ghi chú nền tảng: trên macOS, wizard cài `gcloud`, `gogcli` và `tailscale`
qua Homebrew; trên Linux, hãy cài thủ công trước.

Tự động khởi động Gateway (khuyến nghị):

- Khi đặt `hooks.enabled=true` và `hooks.gmail.account`, Gateway khởi động
  `gog gmail watch serve` khi boot và tự động gia hạn watch.
- Đặt `OPENCLAW_SKIP_GMAIL_WATCHER=1` để từ chối (hữu ích nếu bạn tự chạy daemon).
- Không chạy daemon thủ công cùng lúc, nếu không bạn sẽ gặp
  `listen tcp 127.0.0.1:8788: bind: address already in use`.

Daemon thủ công (khởi động `gog gmail watch serve` + tự gia hạn):

```bash
openclaw webhooks gmail run
```

## Thiết lập một lần

1. Chọn dự án GCP **sở hữu OAuth client** được `gog` sử dụng.

```bash
gcloud auth login
gcloud config set project <project-id>
```

Lưu ý: Gmail watch yêu cầu topic Pub/Sub nằm trong cùng dự án với OAuth client.

2. Bật các API:

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Tạo topic:

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Cho phép Gmail push xuất bản:

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

## Bắt đầu watch

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Lưu `history_id` từ đầu ra (để gỡ lỗi).

## Chạy trình xử lý push

Ví dụ cục bộ (xác thực bằng token dùng chung):

```bash
gog gmail watch serve \
  --account openclaw@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token OPENCLAW_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

Ghi chú:

- `--token` bảo vệ endpoint push (`x-gog-token` hoặc `?token=`).
- `--hook-url` trỏ tới OpenClaw `/hooks/gmail` (đã ánh xạ; chạy cô lập + tóm tắt về chính).
- `--include-body` và `--max-bytes` điều khiển đoạn body gửi tới OpenClaw.

Khuyến nghị: `openclaw webhooks gmail run` bao bọc cùng luồng và tự động gia hạn watch.

## Phơi bày handler (nâng cao, không được hỗ trợ)

Nếu bạn cần tunnel không phải Tailscale, hãy tự nối thủ công và dùng URL công khai trong
subscription push (không được hỗ trợ, không có guardrails):

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Dùng URL được tạo làm endpoint push:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

Production: dùng endpoint HTTPS ổn định và cấu hình Pub/Sub OIDC JWT, sau đó chạy:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Kiểm thử

Gửi một email tới hộp thư đang được theo dõi:

```bash
gog gmail send \
  --account openclaw@gmail.com \
  --to openclaw@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Kiểm tra trạng thái watch và lịch sử:

```bash
gog gmail watch status --account openclaw@gmail.com
gog gmail history --account openclaw@gmail.com --since <historyId>
```

## Xử lý sự cố

- `Invalid topicName`: lệch dự án (topic không nằm trong dự án OAuth client).
- `User not authorized`: thiếu `roles/pubsub.publisher` trên topic.
- Tin nhắn rỗng: Gmail push chỉ cung cấp `historyId`; hãy lấy qua `gog gmail history`.

## Dọn dẹp

```bash
gog gmail watch stop --account openclaw@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
