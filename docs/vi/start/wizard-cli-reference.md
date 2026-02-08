---
summary: "Tham chiếu đầy đủ cho luồng hướng dẫn ban đầu bằng CLI, thiết lập xác thực/mô hình, đầu ra và nội bộ"
read_when:
  - Bạn cần hành vi chi tiết cho openclaw onboard
  - Bạn đang gỡ lỗi kết quả onboarding hoặc tích hợp các client onboarding
title: "Tham chiếu Onboarding CLI"
sidebarTitle: "Tham chiếu CLI"
x-i18n:
  source_path: start/wizard-cli-reference.md
  source_hash: 20bb32d6fd952345
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:38Z
---

# Tham chiếu Onboarding CLI

Trang này là tài liệu tham chiếu đầy đủ cho `openclaw onboard`.
Đối với hướng dẫn ngắn gọn, xem [Onboarding Wizard (CLI)](/start/wizard).

## Wizard làm gì

Chế độ cục bộ (mặc định) sẽ hướng dẫn bạn qua:

- Thiết lập mô hình và xác thực (OAuth gói OpenAI Code, khóa API Anthropic hoặc setup token, cùng các tùy chọn MiniMax, GLM, Moonshot và AI Gateway)
- Vị trí workspace và các tệp bootstrap
- Cài đặt Gateway (cổng, bind, xác thực, tailscale)
- Kênh và nhà cung cấp (Telegram, WhatsApp, Discord, Google Chat, plugin Mattermost, Signal)
- Cài đặt daemon (LaunchAgent hoặc systemd user unit)
- Kiểm tra sức khỏe
- Thiết lập Skills

Chế độ từ xa cấu hình máy này để kết nối tới một gateway ở nơi khác.
Nó không cài đặt hay chỉnh sửa bất cứ thứ gì trên máy chủ từ xa.

## Chi tiết luồng cục bộ

<Steps>
  <Step title="Phát hiện cấu hình hiện có">
    - Nếu `~/.openclaw/openclaw.json` tồn tại, chọn Giữ nguyên, Sửa đổi hoặc Đặt lại.
    - Chạy lại wizard sẽ không xóa gì trừ khi bạn chủ động chọn Đặt lại (hoặc truyền `--reset`).
    - Nếu cấu hình không hợp lệ hoặc chứa khóa cũ, wizard sẽ dừng và yêu cầu bạn chạy `openclaw doctor` trước khi tiếp tục.
    - Đặt lại sử dụng `trash` và cung cấp các phạm vi:
      - Chỉ cấu hình
      - Cấu hình + thông tin xác thực + phiên
      - Đặt lại toàn bộ (cũng xóa workspace)
  </Step>
  <Step title="Mô hình và xác thực">
    - Ma trận tùy chọn đầy đủ nằm trong [Tùy chọn xác thực và mô hình](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Mặc định `~/.openclaw/workspace` (có thể cấu hình).
    - Tạo sẵn các tệp workspace cần thiết cho nghi thức bootstrap lần chạy đầu tiên.
    - Bố cục workspace: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Hỏi về cổng, bind, chế độ xác thực và khả năng hiển thị qua tailscale.
    - Khuyến nghị: giữ xác thực bằng token ngay cả với loopback để các client WS cục bộ vẫn phải xác thực.
    - Chỉ tắt xác thực nếu bạn hoàn toàn tin tưởng mọi tiến trình cục bộ.
    - Bind không phải loopback vẫn yêu cầu xác thực.
  </Step>
  <Step title="Kênh">
    - [WhatsApp](/channels/whatsapp): đăng nhập QR tùy chọn
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): JSON tài khoản dịch vụ + webhook audience
    - Plugin [Mattermost](/channels/mattermost): bot token + URL cơ sở
    - [Signal](/channels/signal): cài đặt `signal-cli` tùy chọn + cấu hình tài khoản
    - [BlueBubbles](/channels/bluebubbles): khuyến nghị cho iMessage; URL máy chủ + mật khẩu + webhook
    - [iMessage](/channels/imessage): đường dẫn CLI `imsg` cũ + quyền truy cập DB
    - Bảo mật DM: mặc định là ghép cặp. DM đầu tiên gửi một mã; phê duyệt qua
      `openclaw pairing approve <channel> <code>` hoặc dùng allowlist.
  </Step>
  <Step title="Cài đặt daemon">
    - macOS: LaunchAgent
      - Yêu cầu phiên người dùng đã đăng nhập; với môi trường headless, dùng LaunchDaemon tùy chỉnh (không đi kèm).
    - Linux và Windows qua WSL2: systemd user unit
      - Wizard cố gắng `loginctl enable-linger <user>` để gateway tiếp tục chạy sau khi đăng xuất.
      - Có thể yêu cầu sudo (ghi `/var/lib/systemd/linger`); trước tiên sẽ thử không dùng sudo.
    - Chọn runtime: Node (khuyến nghị; bắt buộc cho WhatsApp và Telegram). Bun không được khuyến nghị.
  </Step>
  <Step title="Kiểm tra sức khỏe">
    - Khởi động gateway (nếu cần) và chạy `openclaw health`.
    - `openclaw status --deep` thêm các probe sức khỏe gateway vào đầu ra trạng thái.
  </Step>
  <Step title="Skills">
    - Đọc các skills khả dụng và kiểm tra yêu cầu.
    - Cho phép bạn chọn trình quản lý node: npm hoặc pnpm (bun không được khuyến nghị).
    - Cài đặt các phụ thuộc tùy chọn (một số dùng Homebrew trên macOS).
  </Step>
  <Step title="Hoàn tất">
    - Tóm tắt và các bước tiếp theo, bao gồm các tùy chọn ứng dụng iOS, Android và macOS.
  </Step>
</Steps>

<Note>
Nếu không phát hiện GUI, wizard sẽ in hướng dẫn chuyển tiếp cổng SSH cho Control UI thay vì mở trình duyệt.
Nếu thiếu tài sản Control UI, wizard sẽ cố gắng build chúng; phương án dự phòng là `pnpm ui:build` (tự động cài đặt phụ thuộc UI).
</Note>

## Chi tiết chế độ từ xa

Chế độ từ xa cấu hình máy này để kết nối tới một gateway ở nơi khác.

<Info>
Chế độ từ xa không cài đặt hay chỉnh sửa bất cứ thứ gì trên máy chủ từ xa.
</Info>

Những gì bạn thiết lập:

- URL gateway từ xa (`ws://...`)
- Token nếu gateway từ xa yêu cầu xác thực (khuyến nghị)

<Note>
- Nếu gateway chỉ loopback, hãy dùng đường hầm SSH hoặc một tailnet.
- Gợi ý khám phá:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Tùy chọn xác thực và mô hình

<AccordionGroup>
  <Accordion title="Khóa API Anthropic (khuyến nghị)">
    Sử dụng `ANTHROPIC_API_KEY` nếu có hoặc yêu cầu nhập khóa, sau đó lưu để daemon sử dụng.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: kiểm tra mục Keychain "Claude Code-credentials"
    - Linux và Windows: tái sử dụng `~/.claude/.credentials.json` nếu có

    Trên macOS, hãy chọn "Always Allow" để các lần khởi động launchd không bị chặn.

  </Accordion>
  <Accordion title="Token Anthropic (dán setup-token)">
    Chạy `claude setup-token` trên bất kỳ máy nào, sau đó dán token.
    Bạn có thể đặt tên; để trống sẽ dùng mặc định.
  </Accordion>
  <Accordion title="Gói OpenAI Code (tái sử dụng Codex CLI)">
    Nếu `~/.codex/auth.json` tồn tại, wizard có thể tái sử dụng.
  </Accordion>
  <Accordion title="Gói OpenAI Code (OAuth)">
    Luồng qua trình duyệt; dán `code#state`.

    Đặt `agents.defaults.model` thành `openai-codex/gpt-5.3-codex` khi mô hình chưa được đặt hoặc là `openai/*`.

  </Accordion>
  <Accordion title="Khóa API OpenAI">
    Sử dụng `OPENAI_API_KEY` nếu có hoặc yêu cầu nhập khóa, sau đó lưu vào
    `~/.openclaw/.env` để launchd có thể đọc.

    Đặt `agents.defaults.model` thành `openai/gpt-5.1-codex` khi mô hình chưa được đặt, là `openai/*`, hoặc `openai-codex/*`.

  </Accordion>
  <Accordion title="Khóa API xAI (Grok)">
    Yêu cầu nhập `XAI_API_KEY` và cấu hình xAI làm nhà cung cấp mô hình.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Yêu cầu `OPENCODE_API_KEY` (hoặc `OPENCODE_ZEN_API_KEY`).
    URL thiết lập: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="Khóa API (chung)">
    Lưu khóa cho bạn.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    Yêu cầu `AI_GATEWAY_API_KEY`.
    Chi tiết thêm: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    Yêu cầu ID tài khoản, ID gateway và `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    Chi tiết thêm: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Cấu hình được ghi tự động.
    Chi tiết thêm: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (tương thích Anthropic)">
    Yêu cầu `SYNTHETIC_API_KEY`.
    Chi tiết thêm: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot và Kimi Coding">
    Cấu hình Moonshot (Kimi K2) và Kimi Coding được ghi tự động.
    Chi tiết thêm: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Bỏ qua">
    Để xác thực chưa được cấu hình.
  </Accordion>
</AccordionGroup>

Hành vi mô hình:

- Chọn mô hình mặc định từ các tùy chọn được phát hiện, hoặc nhập thủ công nhà cung cấp và mô hình.
- Wizard chạy kiểm tra mô hình và cảnh báo nếu mô hình đã cấu hình không xác định hoặc thiếu xác thực.

Đường dẫn thông tin xác thực và hồ sơ:

- Thông tin xác thực OAuth: `~/.openclaw/credentials/oauth.json`
- Hồ sơ xác thực (khóa API + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Mẹo cho môi trường headless và máy chủ: hoàn tất OAuth trên máy có trình duyệt, sau đó sao chép
`~/.openclaw/credentials/oauth.json` (hoặc `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
sang máy chủ gateway.
</Note>

## Đầu ra và nội bộ

Các trường điển hình trong `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (nếu chọn Minimax)
- `gateway.*` (chế độ, bind, xác thực, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Allowlist kênh (Slack, Discord, Matrix, Microsoft Teams) khi bạn chọn tham gia trong các prompt (tên sẽ được ánh xạ sang ID khi có thể)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` ghi `agents.list[]` và tùy chọn `bindings`.

Thông tin xác thực WhatsApp nằm dưới `~/.openclaw/credentials/whatsapp/<accountId>/`.
Các phiên được lưu dưới `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Một số kênh được phân phối dưới dạng plugin. Khi được chọn trong quá trình onboarding, wizard sẽ
yêu cầu cài đặt plugin (npm hoặc đường dẫn cục bộ) trước khi cấu hình kênh.
</Note>

RPC của Gateway wizard:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Các client (ứng dụng macOS và Control UI) có thể hiển thị các bước mà không cần triển khai lại logic onboarding.

Hành vi thiết lập Signal:

- Tải xuống tài sản phát hành phù hợp
- Lưu dưới `~/.openclaw/tools/signal-cli/<version>/`
- Ghi `channels.signal.cliPath` trong cấu hình
- Các bản build JVM yêu cầu Java 21
- Bản build native được dùng khi có sẵn
- Windows sử dụng WSL2 và theo luồng signal-cli của Linux bên trong WSL

## Tài liệu liên quan

- Trung tâm onboarding: [Onboarding Wizard (CLI)](/start/wizard)
- Tự động hóa và script: [CLI Automation](/start/wizard-cli-automation)
- Tham chiếu lệnh: [`openclaw onboard`](/cli/onboard)
