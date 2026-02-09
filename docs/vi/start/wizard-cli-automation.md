---
summary: "Onboarding bằng script và thiết lập tác tử cho OpenClaw CLI"
read_when:
  - Bạn đang tự động hóa onboarding trong script hoặc CI
  - Bạn cần các ví dụ không tương tác cho từng nhà cung cấp cụ thể
title: "Tự động hóa CLI"
sidebarTitle: "CLI automation"
---

# Tự động hóa CLI

Sử dụng `--non-interactive` để tự động hóa `openclaw onboard`.

<Note>
`--json` không ngụ ý chế độ không tương tác. Use `--non-interactive` (and `--workspace`) for scripts.
</Note>

## Ví dụ không tương tác cơ bản

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

Thêm `--json` để có bản tóm tắt ở dạng máy có thể đọc.

## Ví dụ theo từng nhà cung cấp

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

## Thêm một tác tử khác

Dùng `openclaw agents add <name>` để tạo một agent riêng với workspace, phiên và hồ sơ xác thực riêng. Chạy không có `--workspace` sẽ khởi động trình hướng dẫn.

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

Những gì nó thiết lập:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Ghi chú:

- Workspace mặc định tuân theo `~/.openclaw/workspace-<agentId>`.
- Thêm `bindings` để định tuyến tin nhắn đến (trình hướng dẫn có thể làm việc này).
- Các cờ không tương tác: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Tài liệu liên quan

- Trung tâm onboarding: [Onboarding Wizard (CLI)](/start/wizard)
- Tham chiếu đầy đủ: [CLI Onboarding Reference](/start/wizard-cli-reference)
- Tham chiếu lệnh: [`openclaw onboard`](/cli/onboard)
