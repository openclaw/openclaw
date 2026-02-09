---
summary: "Tài liệu tham chiếu đầy đủ cho trình hướng dẫn CLI onboarding: mọi bước, cờ và trường cấu hình"
read_when:
  - Tra cứu một bước hoặc cờ cụ thể của trình hướng dẫn
  - Tự động hóa onboarding với chế độ không tương tác
  - Gỡ lỗi hành vi của trình hướng dẫn
title: "Tài liệu tham chiếu Trình hướng dẫn Onboarding"
sidebarTitle: "Wizard Reference"
---

# Tài liệu tham chiếu Trình hướng dẫn Onboarding

14. Đây là tài liệu tham chiếu đầy đủ cho trình hướng dẫn CLI `openclaw onboard`.
    Để có cái nhìn tổng quan cấp cao, xem [Onboarding Wizard](/start/wizard).

## Chi tiết luồng (chế độ local)

<Steps>
  <Step title="Existing config detection">
    - If `~/.openclaw/openclaw.json` exists, choose **Keep / Modify / Reset**.
    - Chạy lại trình hướng dẫn **không** xóa bất cứ thứ gì trừ khi bạn chủ động chọn **Đặt lại** (hoặc truyền `--reset`).
    - Nếu cấu hình không hợp lệ hoặc chứa khóa cũ, trình hướng dẫn sẽ dừng và yêu cầu bạn chạy `openclaw doctor` trước khi tiếp tục.
    - Reset uses `trash` (never `rm`) and offers scopes:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes workspace)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API key (recommended)**: uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
    15. - **Anthropic OAuth (Claude Code CLI)**: trên macOS, trình hướng dẫn kiểm tra mục Keychain "Claude Code-credentials" (chọn "Always Allow" để các lần khởi động qua launchd không bị chặn); trên Linux/Windows, nó tái sử dụng `~/.claude/.credentials.json` nếu có.
    - **Anthropic token (paste setup-token)**: run `claude setup-token` on any machine, then paste the token (you can name it; blank = default).
    16. - **OpenAI Code (Codex) subscription (Codex CLI)**: nếu `~/.codex/auth.json` tồn tại, trình hướng dẫn có thể tái sử dụng.
    17. - **OpenAI Code (Codex) subscription (OAuth)**: luồng qua trình duyệt; dán `code#state`.
      - Đặt `agents.defaults.model` thành `openai-codex/gpt-5.2` khi model chưa được đặt hoặc là `openai/*`.
    - **OpenAI API key**: uses `OPENAI_API_KEY` if present or prompts for a key, then saves it to `~/.openclaw/.env` so launchd can read it.
    - **xAI (Grok) API key**: prompts for `XAI_API_KEY` and configures xAI as a model provider.
    18. - **OpenCode Zen (multi-model proxy)**: yêu cầu `OPENCODE_API_KEY` (hoặc `OPENCODE_ZEN_API_KEY`, lấy tại https://opencode.ai/auth).
    - **Khóa API**: lưu khóa cho bạn.
    - **Vercel AI Gateway (proxy đa mô hình)**: nhắc nhập `AI_GATEWAY_API_KEY`.
    - Chi tiết thêm: [Vercel AI Gateway](/providers/vercel-ai-gateway)
  - **Cloudflare AI Gateway**: nhắc nhập Account ID, Gateway ID và `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - Chi tiết thêm: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
  - **MiniMax M2.1**: cấu hình được ghi tự động.
    - More detail: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.
    - Chi tiết thêm: [Synthetic](/providers/synthetic)
  - **Moonshot (Kimi K2)**: cấu hình được ghi tự động.
    19. - **Kimi Coding**: cấu hình được ghi tự động.
    20. - Thông tin chi tiết hơn: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: chưa cấu hình xác thực.
    - Pick a default model from detected options (or enter provider/model manually).
    - Wizard chạy kiểm tra mô hình và cảnh báo nếu mô hình đã cấu hình không xác định hoặc thiếu xác thực.
    - OAuth credentials live in `~/.openclaw/credentials/oauth.json`; auth profiles live in `~/.openclaw/agents/<agentId>21. /agent/auth-profiles.json` (API keys + OAuth).
    - Xem thêm chi tiết: [/concepts/oauth](/concepts/oauth)    
<Note>
    Mẹo cho headless/server: hoàn tất OAuth trên một máy có trình duyệt, sau đó sao chép
    `~/.openclaw/credentials/oauth.json` (hoặc `$OPENCLAW_STATE_DIR/credentials/oauth.json`) sang
    máy chủ gateway.
    </Note>
  </Step>
  <Step title="Workspace">
    - Khởi tạo các tệp workspace cần thiết cho nghi thức bootstrap của agent.
    - Cổng, bind, chế độ xác thực, phơi bày qua tailscale.
    - Bố cục workspace đầy đủ + hướng dẫn sao lưu: [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Port, bind, auth mode, tailscale exposure.
    22. - Khuyến nghị xác thực: giữ **Token** ngay cả cho loopback để các client WS cục bộ vẫn phải xác thực.
    - Disable auth only if you fully trust every local process.
    23. - Các bind không phải loopback vẫn yêu cầu xác thực.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Google Chat](/channels/googlechat): JSON tài khoản dịch vụ + webhook audience.
    24. - [Google Chat](/channels/googlechat): JSON tài khoản dịch vụ + audience webhook.
    - [Signal](/channels/signal): cài đặt `signal-cli` tùy chọn + cấu hình tài khoản.
    - [Signal](/channels/signal): optional `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **recommended for iMessage**; server URL + password + webhook.
    25. - [iMessage](/channels/imessage): đường dẫn CLI `imsg` legacy + quyền truy cập DB.
    26. - Bảo mật DM: mặc định là ghép cặp. DM đầu tiên gửi một mã; phê duyệt qua `openclaw pairing approve <channel><code>` hoặc dùng allowlists.
  </Step><code>` hoặc dùng allowlist.
  27. </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Yêu cầu có phiên người dùng đang đăng nhập; với môi trường headless, dùng LaunchDaemon tùy chỉnh (không kèm theo).
    28. - Linux (và Windows qua WSL2): systemd user unit
      - Trình hướng dẫn cố gắng bật lingering bằng `loginctl enable-linger <user>` để Gateway tiếp tục chạy sau khi đăng xuất.
      29. - Có thể yêu cầu sudo (ghi vào `/var/lib/systemd/linger`); nó sẽ thử không dùng sudo trước.
    30. - **Lựa chọn runtime:** Node (khuyến nghị; bắt buộc cho WhatsApp/Telegram). Bun is **not recommended**.
  </Step>
  <Step title="Health check">
    - Starts the Gateway (if needed) and runs `openclaw health`.
    - Tip: `openclaw status --deep` adds gateway health probes to status output (requires a reachable gateway).
  </Step>
  <Step title="Skills (recommended)">
    - Reads the available skills and checks requirements.
    - Cho phép bạn chọn trình quản lý node: **npm / pnpm** (bun không được khuyến nghị).
    - Installs optional dependencies (some use Homebrew on macOS).
  </Step>
  <Step title="Finish">
    - Summary + next steps, including iOS/Android/macOS apps for extra features.
  </Step>
</Steps>

<Note>
Nếu không phát hiện GUI, trình hướng dẫn sẽ in hướng dẫn chuyển tiếp cổng SSH cho Control UI thay vì mở trình duyệt.
If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
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
`--json` does **not** imply non-interactive mode. Dùng `--non-interactive` (và `--workspace`) cho các script.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
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
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
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

The Gateway exposes the wizard flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Các client (ứng dụng macOS, Control UI) có thể render các bước mà không cần tái triển khai logic onboarding.

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

WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.openclaw/agents/<agentId>/sessions/`.

Some channels are delivered as plugins. When you pick one during onboarding, the wizard
will prompt to install it (npm or a local path) before it can be configured.

## Tài liệu liên quan

- Tổng quan trình hướng dẫn: [Onboarding Wizard](/start/wizard)
- Onboarding ứng dụng macOS: [Onboarding](/start/onboarding)
- Tài liệu tham chiếu cấu hình: [Gateway configuration](/gateway/configuration)
- Nhà cung cấp: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (cũ)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
