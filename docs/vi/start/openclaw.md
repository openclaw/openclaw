---
summary: "Hướng dẫn đầu-cuối để chạy OpenClaw như một trợ lý cá nhân kèm các lưu ý an toàn"
read_when:
  - Hướng dẫn ban đầu cho một phiên bản trợ lý mới
  - Xem xét các tác động về an toàn/quyền hạn
title: "Thiết lập Trợ lý Cá nhân"
---

# Xây dựng một trợ lý cá nhân với OpenClaw

OpenClaw là một gateway WhatsApp + Telegram + Discord + iMessage cho các agent **Pi**. Plugin bổ sung Mattermost. Hướng dẫn này là thiết lập "trợ lý cá nhân": một số WhatsApp chuyên dụng hoạt động như agent luôn bật của bạn.

## ⚠️ An toàn là trên hết

Bạn đang đặt một tác tử vào vị trí có thể:

- chạy lệnh trên máy của bạn (tùy theo thiết lập công cụ Pi)
- đọc/ghi tệp trong workspace của bạn
- gửi tin nhắn ra ngoài qua WhatsApp/Telegram/Discord/Mattermost (plugin)

Hãy bắt đầu thận trọng:

- Luôn đặt `channels.whatsapp.allowFrom` (không bao giờ chạy mở ra toàn thế giới trên máy Mac cá nhân).
- Dùng một số WhatsApp chuyên dụng cho trợ lý.
- Heartbeats now default to every 30 minutes. Hãy tắt cho đến khi bạn tin tưởng thiết lập bằng cách đặt `agents.defaults.heartbeat.every: "0m"`.

## Điều kiện tiên quyết

- Đã cài đặt và hoàn tất onboarding OpenClaw — xem [Bắt đầu](/start/getting-started) nếu bạn chưa làm
- Một số điện thoại thứ hai (SIM/eSIM/trả trước) cho trợ lý

## Thiết lập hai điện thoại (khuyến nghị)

Bạn muốn như sau:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Nếu bạn liên kết WhatsApp cá nhân với OpenClaw, mọi tin nhắn gửi cho bạn sẽ trở thành “đầu vào của agent”. Điều đó hiếm khi là điều bạn muốn.

## Khởi động nhanh 5 phút

1. Ghép nối WhatsApp Web (hiện QR; quét bằng điện thoại của trợ lý):

```bash
openclaw channels login
```

2. Khởi chạy Gateway (để nó chạy):

```bash
openclaw gateway --port 18789
```

3. Đặt cấu hình tối thiểu trong `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Giờ hãy nhắn tin tới số trợ lý từ điện thoại nằm trong danh sách cho phép của bạn.

Khi onboarding hoàn tất, chúng tôi tự động mở dashboard và in ra một liên kết sạch (không chứa token). Nếu nó yêu cầu xác thực, hãy dán token từ `gateway.auth.token` vào cài đặt Control UI. Để mở lại sau này: `openclaw dashboard`.

## Cấp cho tác tử một workspace (AGENTS)

OpenClaw đọc chỉ dẫn vận hành và “bộ nhớ” từ thư mục workspace của nó.

Theo mặc định, OpenClaw sử dụng `~/.openclaw/workspace` làm workspace cho agent và sẽ tự động tạo nó (cùng với các tệp khởi đầu `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) trong quá trình thiết lập/lần chạy agent đầu tiên. `BOOTSTRAP.md` chỉ được tạo khi workspace hoàn toàn mới (nó không nên xuất hiện lại sau khi bạn xóa). `MEMORY.md` is optional (not auto-created); when present, it is loaded for normal sessions. Subagent sessions only inject `AGENTS.md` and `TOOLS.md`.

Tip: treat this folder like OpenClaw’s “memory” and make it a git repo (ideally private) so your `AGENTS.md` + memory files are backed up. If git is installed, brand-new workspaces are auto-initialized.

```bash
openclaw setup
```

Bố cục workspace đầy đủ + hướng dẫn sao lưu: [Agent workspace](/concepts/agent-workspace)  
Quy trình bộ nhớ: [Memory](/concepts/memory)

Tùy chọn: chọn một workspace khác với `agents.defaults.workspace` (hỗ trợ `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Nếu bạn đã tự cung cấp các tệp workspace từ một repo, bạn có thể tắt hoàn toàn việc tạo tệp bootstrap:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## Cấu hình biến nó thành “một trợ lý”

OpenClaw mặc định đã là một thiết lập trợ lý tốt, nhưng bạn thường sẽ muốn tinh chỉnh:

- persona/chỉ dẫn trong `SOUL.md`
- mặc định về suy nghĩ (nếu muốn)
- heartbeats (khi bạn đã tin tưởng)

Ví dụ:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Phiên và bộ nhớ

- Tệp phiên: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Metadata phiên (mức dùng token, tuyến cuối cùng, v.v.): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (cũ: `~/.openclaw/sessions/sessions.json`)
- `/new` hoặc `/reset` bắt đầu một phiên mới cho cuộc chat đó (có thể cấu hình qua `resetTriggers`). Nếu được gửi riêng lẻ, agent sẽ trả lời bằng một lời chào ngắn để xác nhận việc reset.
- `/compact [instructions]` nén ngữ cảnh phiên và báo cáo ngân sách ngữ cảnh còn lại.

## Heartbeats (chế độ chủ động)

By default, OpenClaw runs a heartbeat every 30 minutes with the prompt:
`Read HEARTBEAT.md if it exists (workspace context). Hãy tuân thủ nghiêm ngặt.
Nếu không có gì cần chú ý, hãy trả lời HEARTBEAT_OK.`
Đặt `agents.defaults.heartbeat.every: "0m"` để tắt. Do not infer or repeat old tasks from prior chats. Cài đặt trên Linux sử dụng dịch vụ **user** của systemd.

- Nếu `HEARTBEAT.md` tồn tại nhưng thực chất trống (chỉ có dòng trống và tiêu đề markdown như `# Heading`), OpenClaw bỏ qua lượt heartbeat để tiết kiệm API calls.
- Nếu tệp bị thiếu, heartbeat vẫn chạy và mô hình tự quyết định làm gì.
- Nếu tác tử trả lời bằng `HEARTBEAT_OK` (tùy chọn kèm đệm ngắn; xem `agents.defaults.heartbeat.ackMaxChars`), OpenClaw sẽ chặn gửi ra ngoài cho heartbeat đó.
- Heartbeats chạy đầy đủ lượt tác tử — khoảng thời gian ngắn hơn sẽ tiêu tốn nhiều token hơn.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Media vào và ra

Tệp đính kèm đầu vào (ảnh/âm thanh/tài liệu) có thể được đưa vào lệnh của bạn qua các template:

- `{{MediaPath}}` (đường dẫn tệp tạm cục bộ)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (nếu bật chuyển âm thanh sang văn bản)

Outbound attachments from the agent: include `MEDIA:<path-or-url>` on its own line (no spaces). Ví dụ:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw trích xuất các mục này và gửi chúng như media kèm theo văn bản.

## Checklist vận hành

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Log nằm tại `/tmp/openclaw/` (mặc định: `openclaw-YYYY-MM-DD.log`).

## Bước tiếp theo

- WebChat: [WebChat](/web/webchat)
- Vận hành Gateway: [Gateway runbook](/gateway)
- Cron + wakeups: [Cron jobs](/automation/cron-jobs)
- Ứng dụng đồng hành thanh menu macOS: [OpenClaw macOS app](/platforms/macos)
- Ứng dụng node iOS: [iOS app](/platforms/ios)
- Ứng dụng node Android: [Android app](/platforms/android)
- Trạng thái Windows: [Windows (WSL2)](/platforms/windows)
- Trạng thái Linux: [Linux app](/platforms/linux)
- Bảo mật: [Security](/gateway/security)
