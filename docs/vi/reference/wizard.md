---
summary: "Tài liệu tham chiếu đầy đủ cho trình hướng dẫn CLI onboarding: mọi bước, cờ và trường cấu hình"
read_when:
  - Tra cứu một bước hoặc cờ cụ thể của trình hướng dẫn
  - Tự động hóa onboarding với chế độ không tương tác
  - Gỡ lỗi hành vi của trình hướng dẫn
title: "Tài liệu tham chiếu Trình hướng dẫn Onboarding"
sidebarTitle: "Wizard Reference"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:26Z
---

# Tài liệu tham chiếu Trình hướng dẫn Onboarding

Đây là tài liệu tham chiếu đầy đủ cho trình hướng dẫn CLI `openclaw onboard`.
Để xem tổng quan cấp cao, hãy xem [Onboarding Wizard](/start/wizard).

## Chi tiết luồng (chế độ local)

<Steps>
  <Step title="Phát hiện cấu hình hiện có">
    - Nếu `~/.openclaw/openclaw.json` tồn tại, chọn **Giữ / Sửa đổi / Đặt lại**.
    - Chạy lại trình hướng dẫn **không** xóa bất cứ thứ gì trừ khi bạn chủ động chọn **Đặt lại**
      (hoặc truyền `--reset`).
    - Nếu cấu hình không hợp lệ hoặc chứa các khóa cũ, trình hướng dẫn sẽ dừng lại và yêu cầu
      bạn chạy `openclaw doctor` trước khi tiếp tục.
    - Đặt lại sử dụng `trash` (không bao giờ dùng `rm`) và cung cấp các phạm vi:
      - Chỉ cấu hình
      - Cấu hình + thông tin xác thực + phiên
      - Đặt lại toàn bộ (cũng xóa workspace)
  </Step>
  <Step title="Model/Auth">
    - **Anthropic API key (khuyến nghị)**: dùng `ANTHROPIC_API_KEY` nếu có hoặc nhắc nhập khóa, sau đó lưu để daemon sử dụng.
    - **Anthropic OAuth (Claude Code CLI)**: trên macOS, trình hướng dẫn kiểm tra mục Keychain "Claude Code-credentials" (chọn "Always Allow" để các lần khởi động launchd không bị chặn); trên Linux/Windows, nó tái sử dụng `~/.claude/.credentials.json` nếu có.
    - **Anthropic token (dán setup-token)**: chạy `claude setup-token` trên bất kỳ máy nào, rồi dán token (bạn có thể đặt tên; để trống = mặc định).
    - **OpenAI Code (Codex) subscription (Codex CLI)**: nếu `~/.codex/auth.json` tồn tại, trình hướng dẫn có thể tái sử dụng.
    - **OpenAI Code (Codex) subscription (OAuth)**: luồng trình duyệt; dán `code#state`.
      - Đặt `agents.defaults.model` thành `openai-codex/gpt-5.2` khi model chưa được đặt hoặc là `openai/*`.
    - **OpenAI API key**: dùng `OPENAI_API_KEY` nếu có hoặc nhắc nhập khóa, sau đó lưu vào `~/.openclaw/.env` để launchd có thể đọc.
    - **xAI (Grok) API key**: nhắc nhập `XAI_API_KEY` và cấu hình xAI làm nhà cung cấp mô hình.
    - **OpenCode Zen (proxy đa mô hình)**: nhắc nhập `OPENCODE_API_KEY` (hoặc `OPENCODE_ZEN_API_KEY`, lấy tại https://opencode.ai/auth).
    - **API key**: lưu khóa cho bạn.
    - **Vercel AI Gateway (proxy đa mô hình)**: nhắc nhập `AI_GATEWAY_API_KEY`.
    - Chi tiết thêm: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: nhắc nhập Account ID, Gateway ID và `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Chi tiết thêm: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: cấu hình được ghi tự động.
    - Chi tiết thêm: [MiniMax](/providers/minimax)
    - **Synthetic (tương thích Anthropic)**: nhắc nhập `SYNTHETIC_API_KEY`.
    - Chi tiết thêm: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: cấu hình được ghi tự động.
    - **Kimi Coding**: cấu hình được ghi tự động.
    - Chi tiết thêm: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Bỏ qua**: chưa cấu hình xác thực.
    - Chọn một model mặc định từ các tùy chọn được phát hiện (hoặc nhập nhà cung cấp/model thủ công).
    - Trình hướng dẫn chạy kiểm tra model và cảnh báo nếu model đã cấu hình không xác định hoặc thiếu xác thực.
    - Thông tin OAuth nằm trong `~/.openclaw/credentials/oauth.json`; hồ sơ xác thực nằm trong `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth).
    - Chi tiết thêm: [/concepts/oauth](/concepts/oauth)
    <Note>
    Mẹo cho headless/server: hoàn tất OAuth trên một máy có trình duyệt, sau đó sao chép
    `~/.openclaw/credentials/oauth.json` (hoặc `$OPENCLAW_STATE_DIR/credentials/oauth.json`) sang
    máy chủ gateway.
    </Note>
  </Step>
  <Step title="Workspace">
    - Mặc định `~/.openclaw/workspace` (có thể cấu hình).
    - Khởi tạo các tệp workspace cần thiết cho nghi thức bootstrap của tác tử.
    - Bố cục workspace đầy đủ + hướng dẫn sao lưu: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - Cổng, bind, chế độ xác thực, mức phơi bày Tailscale.
    - Khuyến nghị xác thực: giữ **Token** ngay cả với loopback để các client WS cục bộ phải xác thực.
    - Chỉ tắt xác thực nếu bạn hoàn toàn tin tưởng mọi tiến trình cục bộ.
    - Các bind không phải loopback vẫn yêu cầu xác thực.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): đăng nhập QR tùy chọn.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): JSON tài khoản dịch vụ + webhook audience.
    - [Mattermost](/channels/mattermost) (plugin): bot token + URL cơ sở.
    - [Signal](/channels/signal): cài đặt `signal-cli` tùy chọn + cấu hình tài khoản.
    - [BlueBubbles](/channels/bluebubbles): **khuyến nghị cho iMessage**; URL máy chủ + mật khẩu + webhook.
    - [iMessage](/channels/imessage): đường dẫn CLI `imsg` cũ + truy cập DB.
    - Bảo mật DM: mặc định là ghép cặp. DM đầu tiên gửi một mã; phê duyệt qua `openclaw pairing approve <channel> <code>` hoặc dùng allowlists.
  </Step>
  <Step title="Cài đặt daemon">
    - macOS: LaunchAgent
      - Yêu cầu phiên người dùng đã đăng nhập; với headless, dùng LaunchDaemon tùy chỉnh (không được phát hành).
    - Linux (và Windows qua WSL2): systemd user unit
      - Trình hướng dẫn cố gắng bật lingering qua `loginctl enable-linger <user>` để Gateway vẫn hoạt động sau khi đăng xuất.
      - Có thể yêu cầu sudo (ghi `/var/lib/systemd/linger`); nó sẽ thử không dùng sudo trước.
    - **Chọn runtime:** Node (khuyến nghị; bắt buộc cho WhatsApp/Telegram). Bun **không được khuyến nghị**.
  </Step>
  <Step title="Kiểm tra sức khỏe">
    - Khởi động Gateway (nếu cần) và chạy `openclaw health`.
    - Mẹo: `openclaw status --deep` thêm các probe sức khỏe gateway vào đầu ra trạng thái (yêu cầu gateway có thể truy cập).
  </Step>
  <Step title="Skills (khuyến nghị)">
    - Đọc các skills có sẵn và kiểm tra yêu cầu.
    - Cho phép bạn chọn trình quản lý node: **npm / pnpm** (bun không được khuyến nghị).
    - Cài đặt các phụ thuộc tùy chọn (một số dùng Homebrew trên macOS).
  </Step>
  <Step title="Hoàn tất">
    - Tóm tắt + các bước tiếp theo, bao gồm ứng dụng iOS/Android/macOS cho các tính năng bổ sung.
  </Step>
</Steps>

<Note>
Nếu không phát hiện GUI, trình hướng dẫn sẽ in hướng dẫn SSH port-forward cho Control UI thay vì mở trình duyệt.
Nếu thiếu tài sản Control UI, trình hướng dẫn sẽ cố gắng build chúng; phương án dự phòng là `pnpm ui:build` (tự động cài đặt phụ thuộc UI).
</Note>

## Chế độ không tương tác

Dùng `--non-interactive` để tự động hóa hoặc viết script cho onboarding:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

Thêm `--json` để có bản tóm tắt dạng máy đọc được.

<Note>
`--json` **không** đồng nghĩa với chế độ không tương tác. Hãy dùng `--non-interactive` (và `--workspace`) cho script.
</Note>

<AccordionGroup>
  <Accordion title="Ví dụ Gemini">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ví dụ Z.AI">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ví dụ Vercel AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ví dụ Cloudflare AI Gateway">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ví dụ Moonshot">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ví dụ Synthetic">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Ví dụ OpenCode Zen">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### Thêm tác tử (không tương tác)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

Gateway cung cấp luồng trình hướng dẫn qua RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Các client (ứng dụng macOS, Control UI) có thể hiển thị các bước mà không cần triển khai lại logic onboarding.

## Thiết lập Signal (signal-cli)

Trình hướng dẫn có thể cài đặt `signal-cli` từ GitHub releases:

- Tải xuống asset phát hành phù hợp.
- Lưu trữ dưới `~/.openclaw/tools/signal-cli/<version>/`.
- Ghi `channels.signal.cliPath` vào cấu hình của bạn.

Ghi chú:

- Bản dựng JVM yêu cầu **Java 21**.
- Bản dựng native được dùng khi có sẵn.
- Windows dùng WSL2; cài đặt signal-cli theo luồng Linux bên trong WSL.

## Những gì trình hướng dẫn ghi

Các trường điển hình trong `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (nếu chọn Minimax)
- `gateway.*` (chế độ, bind, xác thực, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Allowlists kênh (Slack/Discord/Matrix/Microsoft Teams) khi bạn chọn trong các lời nhắc (tên sẽ được phân giải thành ID khi có thể).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` ghi `agents.list[]` và `bindings` tùy chọn.

Thông tin xác thực WhatsApp nằm dưới `~/.openclaw/credentials/whatsapp/<accountId>/`.
Các phiên được lưu dưới `~/.openclaw/agents/<agentId>/sessions/`.

Một số kênh được cung cấp dưới dạng plugin. Khi bạn chọn một kênh trong quá trình onboarding, trình hướng dẫn
sẽ nhắc cài đặt nó (npm hoặc đường dẫn cục bộ) trước khi có thể cấu hình.

## Tài liệu liên quan

- Tổng quan trình hướng dẫn: [Onboarding Wizard](/start/wizard)
- Onboarding ứng dụng macOS: [Onboarding](/start/onboarding)
- Tài liệu tham chiếu cấu hình: [Gateway configuration](/gateway/configuration)
- Nhà cung cấp: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (cũ)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
