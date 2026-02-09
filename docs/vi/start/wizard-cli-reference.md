---
summary: "Tham chiếu đầy đủ cho luồng hướng dẫn ban đầu bằng CLI, thiết lập xác thực/mô hình, đầu ra và nội bộ"
read_when:
  - Bạn cần hành vi chi tiết cho openclaw onboard
  - Bạn đang gỡ lỗi kết quả onboarding hoặc tích hợp các client onboarding
title: "Tham chiếu Onboarding CLI"
sidebarTitle: "Tham chiếu CLI"
---

# Tham chiếu Onboarding CLI

This page is the full reference for `openclaw onboard`.
For the short guide, see [Onboarding Wizard (CLI)](/start/wizard).

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
Nó không cài đặt hay sửa đổi bất cứ thứ gì trên host từ xa.

## Chi tiết luồng cục bộ

<Steps>
  <Step title="Existing config detection">
    - Nếu `~/.openclaw/openclaw.json` tồn tại, hãy chọn Keep, Modify hoặc Reset.
    - Re-running the wizard does not wipe anything unless you explicitly choose Reset (or pass `--reset`).
    - If config is invalid or contains legacy keys, the wizard stops and asks you to run `openclaw doctor` before continuing.
    - Reset uses `trash` and offers scopes:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes workspace)  
</Step>
  <Step title="Model and auth">
    - Ma trận tùy chọn đầy đủ nằm trong [Tùy chọn xác thực và mô hình](#auth-and-model-options).
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (configurable).
    - Seeds workspace files needed for first-run bootstrap ritual.
    - Bố cục không gian làm việc: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Hỏi về cổng, bind, chế độ xác thực và mức phơi bày tailscale.
    - Khuyến nghị: giữ bật xác thực bằng token ngay cả cho loopback để các client WS cục bộ vẫn phải xác thực.
    - Chỉ tắt xác thực nếu bạn hoàn toàn tin tưởng mọi tiến trình cục bộ.
    - Non-loopback binds still require auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): đăng nhập QR tùy chọn
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): JSON service account + webhook audience
    - [Mattermost](/channels/mattermost) plugin: bot token + base URL
    - [Signal](/channels/signal): cài đặt `signal-cli` tùy chọn + cấu hình tài khoản
    - [BlueBubbles](/channels/bluebubbles): khuyến nghị cho iMessage; URL server + mật khẩu + webhook
    - [iMessage](/channels/imessage): đường dẫn CLI `imsg` legacy + truy cập DB
    - Bảo mật DM: mặc định là ghép cặp. DM đầu tiên gửi một mã; phê duyệt bằng
      `openclaw pairing approve <channel><code>` hoặc dùng allowlist.
  </Step><code>` hoặc dùng allowlist.
  </Step>
  <Step title="Cài đặt daemon">
    - macOS: LaunchAgent
      - Yêu cầu phiên người dùng đã đăng nhập; với headless, dùng LaunchDaemon tùy chỉnh (không đi kèm).
    1. - Linux và Windows thông qua WSL2: systemd user unit
      - Trình hướng dẫn cố gắng chạy `loginctl enable-linger <user>` để gateway vẫn hoạt động sau khi đăng xuất.
      2. - Có thể yêu cầu sudo (ghi vào `/var/lib/systemd/linger`); nó sẽ thử không dùng sudo trước.
    3. - Lựa chọn runtime: Node (khuyến nghị; bắt buộc cho WhatsApp và Telegram). 4. Bun không được khuyến nghị.
  5. </Step>
  <Step title="Health check">
    - Khởi động gateway (nếu cần) và chạy `openclaw health`.
    6. - `openclaw status --deep` thêm các probe kiểm tra sức khỏe gateway vào đầu ra trạng thái.
  7. </Step>
  <Step title="Skills">
    - Đọc các skill có sẵn và kiểm tra yêu cầu.
    8. - Cho phép bạn chọn trình quản lý node: npm hoặc pnpm (bun không được khuyến nghị).
    9. - Cài đặt các phụ thuộc tùy chọn (một số dùng Homebrew trên macOS).
  </Step>
  <Step title="Finish">
    - Summary and next steps, including iOS, Android, and macOS app options.
  </Step>
</Steps>

<Note>
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
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
14. - Nếu gateway chỉ lắng nghe trên loopback, hãy dùng SSH tunneling hoặc một tailnet.
- Discovery hints:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Tùy chọn xác thực và mô hình

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    Sử dụng `ANTHROPIC_API_KEY` nếu có hoặc yêu cầu nhập khóa, sau đó lưu để daemon sử dụng.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: kiểm tra mục Keychain "Claude Code-credentials"
    - Linux và Windows: tái sử dụng `~/.claude/.credentials.json` nếu có

    ```
    Trên macOS, hãy chọn "Always Allow" để các lần khởi động launchd không bị chặn.
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    Run `claude setup-token` on any machine, then paste the token.
    You can name it; blank uses default.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    Nếu `~/.codex/auth.json` tồn tại, wizard có thể tái sử dụng.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Luồng qua trình duyệt; dán `code#state`.

    ```
    Đặt `agents.defaults.model` thành `openai-codex/gpt-5.3-codex` khi mô hình chưa được đặt hoặc là `openai/*`.
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    Sử dụng `OPENAI_API_KEY` nếu có hoặc yêu cầu nhập khóa, sau đó lưu vào
    `~/.openclaw/.env` để launchd có thể đọc.

    ```
    Đặt `agents.defaults.model` thành `openai/gpt-5.1-codex` khi mô hình chưa được đặt, là `openai/*`, hoặc `openai-codex/*`.
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    Yêu cầu nhập `XAI_API_KEY` và cấu hình xAI làm nhà cung cấp mô hình.
  </Accordion>
  <Accordion title="OpenCode Zen">
    Prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`).
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    Lưu khóa cho bạn.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    20. Nhắc nhập `AI_GATEWAY_API_KEY`.
    21. Thông tin chi tiết: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    22. Nhắc nhập account ID, gateway ID và `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Config is auto-written.
    More detail: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    Prompts for `SYNTHETIC_API_KEY`.
    More detail: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) and Kimi Coding configs are auto-written.
    29. Thông tin chi tiết: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
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

WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.
31. Các phiên được lưu tại `~/.openclaw/agents/<agentId>/sessions/`.

<Note>
Some channels are delivered as plugins. When selected during onboarding, the wizard
prompts to install the plugin (npm or local path) before channel configuration.
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
