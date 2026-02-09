---
summary: "Định tuyến đa tác tử: tác tử cô lập, tài khoản kênh và các ràng buộc"
title: Định tuyến đa tác tử
read_when: "Bạn muốn nhiều tác tử cô lập (workspace + xác thực) trong một tiến trình gateway."
status: active
---

# Định tuyến đa tác tử

Mục tiêu: nhiều agent _cô lập_ (workspace + `agentDir` + phiên riêng), cùng với nhiều tài khoản kênh (ví dụ: hai WhatsApp) trong một Gateway đang chạy. Lưu lượng vào được định tuyến đến một agent thông qua các binding.

## “Một tác tử” là gì?

Một **tác tử** là một bộ não được phạm vi hóa đầy đủ với:

- **Workspace** (tệp, AGENTS.md/SOUL.md/USER.md, ghi chú cục bộ, quy tắc persona).
- **Thư mục trạng thái** (`agentDir`) cho hồ sơ xác thực, registry mô hình và cấu hình theo từng tác tử.
- **Kho phiên** (lịch sử chat + trạng thái định tuyến) nằm dưới `~/.openclaw/agents/<agentId>/sessions`.

Hồ sơ xác thực là **theo từng agent**. Mỗi agent đọc từ phần riêng của nó:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Thông tin xác thực của agent chính **không** được chia sẻ tự động. Never reuse `agentDir`
across agents (it causes auth/session collisions). Nếu bạn muốn chia sẻ thông tin xác thực, hãy sao chép `auth-profiles.json` vào `agentDir` của agent kia.

Skills là theo từng agent thông qua thư mục `skills/` của mỗi workspace, với các skill dùng chung có sẵn tại `~/.openclaw/skills`. Xem [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

Gateway có thể lưu trữ **một tác tử** (mặc định) hoặc **nhiều tác tử** song song.

**Ghi chú workspace:** workspace của mỗi agent là **cwd mặc định**, không phải một sandbox cứng. Relative paths resolve inside the workspace, but absolute paths can
reach other host locations unless sandboxing is enabled. Xem [Sandboxing](/gateway/sandboxing).

## Đường dẫn (bản đồ nhanh)

- Cấu hình: `~/.openclaw/openclaw.json` (hoặc `OPENCLAW_CONFIG_PATH`)
- Thư mục trạng thái: `~/.openclaw` (hoặc `OPENCLAW_STATE_DIR`)
- Workspace: `~/.openclaw/workspace` (hoặc `~/.openclaw/workspace-<agentId>`)
- Thư mục tác tử: `~/.openclaw/agents/<agentId>/agent` (hoặc `agents.list[].agentDir`)
- Phiên: `~/.openclaw/agents/<agentId>/sessions`

### Chế độ một tác tử (mặc định)

Nếu bạn không làm gì, OpenClaw chạy một tác tử duy nhất:

- `agentId` mặc định là **`main`**.
- Phiên được khóa theo `agent:main:<mainKey>`.
- Workspace mặc định là `~/.openclaw/workspace` (hoặc `~/.openclaw/workspace-<profile>` khi `OPENCLAW_PROFILE` được đặt).
- Trạng thái mặc định là `~/.openclaw/agents/main/agent`.

## Trợ lý tác tử

Dùng trình hướng dẫn tác tử để thêm một tác tử cô lập mới:

```bash
openclaw agents add work
```

Sau đó thêm `bindings` (hoặc để trình hướng dẫn làm) để định tuyến tin nhắn vào.

Xác minh bằng:

```bash
openclaw agents list --bindings
```

## Nhiều tác tử = nhiều người, nhiều cá tính

Với **nhiều tác tử**, mỗi `agentId` trở thành một **persona cô lập hoàn toàn**:

- **Số điện thoại/tài khoản khác nhau** (theo từng kênh `accountId`).
- **Cá tính khác nhau** (tệp workspace theo tác tử như `AGENTS.md` và `SOUL.md`).
- **Xác thực + phiên tách biệt** (không có giao thoa trừ khi bật rõ ràng).

Điều này cho phép **nhiều người** dùng chung một máy chủ Gateway trong khi vẫn giữ “bộ não” AI và dữ liệu được cô lập.

## Một số WhatsApp, nhiều người (tách DM)

Bạn có thể định tuyến **các DM WhatsApp khác nhau** đến các agent khác nhau trong khi vẫn dùng **một tài khoản WhatsApp**. Khớp theo E.164 của người gửi (như `+15551234567`) với `peer.kind: "dm"`. Phản hồi vẫn đến từ cùng một số WhatsApp (không có danh tính người gửi theo từng agent).

Chi tiết quan trọng: chat trực tiếp được gộp về **khóa phiên chính** của tác tử, vì vậy để cô lập thực sự cần **mỗi người một tác tử**.

Ví dụ:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

Ghi chú:

- Kiểm soát truy cập DM là **toàn cục theo tài khoản WhatsApp** (ghép cặp/danh sách cho phép), không theo tác tử.
- Với nhóm dùng chung, hãy gán nhóm cho một tác tử hoặc dùng [Broadcast groups](/channels/broadcast-groups).

## Quy tắc định tuyến (cách tin nhắn chọn tác tử)

Các ràng buộc là **xác định** và **cụ thể nhất sẽ thắng**:

1. Khớp `peer` (DM/nhóm/id kênh chính xác)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. Khớp `accountId` cho một kênh
5. Khớp cấp kênh (`accountId: "*"`)
6. Rơi về tác tử mặc định (`agents.list[].default`, nếu không thì mục đầu tiên trong danh sách, mặc định: `main`)

## Nhiều tài khoản / số điện thoại

Các kênh hỗ trợ **nhiều tài khoản** (ví dụ: WhatsApp) sử dụng `accountId` để định danh từng lần đăng nhập. Mỗi `accountId` có thể được định tuyến đến một agent khác nhau, vì vậy một máy chủ có thể lưu trữ nhiều số điện thoại mà không trộn lẫn phiên.

## Khái niệm

- `agentId`: một “bộ não” (workspace, xác thực theo tác tử, kho phiên theo tác tử).
- `accountId`: một phiên bản tài khoản kênh (ví dụ tài khoản WhatsApp `"personal"` so với `"biz"`).
- `binding`: định tuyến tin nhắn vào tới một `agentId` theo `(channel, accountId, peer)` và tùy chọn id guild/team.
- Chat trực tiếp được gộp về `agent:<agentId>:<mainKey>` (theo tác tử “chính”; `session.mainKey`).

## Ví dụ: hai WhatsApp → hai tác tử

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## Ví dụ: WhatsApp chat hằng ngày + Telegram làm việc sâu

Chia theo kênh: định tuyến WhatsApp tới tác tử nhanh dùng hằng ngày và Telegram tới tác tử Opus.

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

Ghi chú:

- Nếu bạn có nhiều tài khoản cho một kênh, hãy thêm `accountId` vào ràng buộc (ví dụ `{ channel: "whatsapp", accountId: "personal" }`).
- Để định tuyến một DM/nhóm cụ thể tới Opus trong khi giữ phần còn lại ở chat, hãy thêm ràng buộc `match.peer` cho peer đó; khớp peer luôn thắng các quy tắc toàn kênh.

## Ví dụ: cùng kênh, một peer tới Opus

Giữ WhatsApp trên tác tử nhanh, nhưng định tuyến một DM tới Opus:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Ràng buộc peer luôn thắng, vì vậy hãy đặt chúng phía trên quy tắc toàn kênh.

## Tác tử gia đình gắn với một nhóm WhatsApp

Gán một tác tử gia đình chuyên dụng cho một nhóm WhatsApp, với kiểm soát theo @mention
và chính sách công cụ chặt chẽ hơn:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

Ghi chú:

- Danh sách cho phép/từ chối công cụ là **tools**, không phải skills. 1. Nếu một kỹ năng cần chạy một
  tệp nhị phân, hãy đảm bảo `exec` được cho phép và tệp nhị phân tồn tại trong sandbox.
- Để kiểm soát chặt hơn, đặt `agents.list[].groupChat.mentionPatterns` và giữ
  danh sách cho phép nhóm được bật cho kênh.

## Sandbox và cấu hình công cụ theo tác tử

Bắt đầu từ v2026.1.6, mỗi tác tử có thể có sandbox và hạn chế công cụ riêng:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

2. Lưu ý: `setupCommand` nằm dưới `sandbox.docker` và chỉ chạy một lần khi tạo container.
3. Các ghi đè `sandbox.docker.*` theo từng agent sẽ bị bỏ qua khi phạm vi đã được phân giải là `"shared"`.

**Lợi ích:**

- **Cô lập bảo mật**: Hạn chế công cụ cho các tác tử không tin cậy
- **Kiểm soát tài nguyên**: Sandbox các tác tử cụ thể trong khi giữ các tác tử khác trên host
- **Chính sách linh hoạt**: Quyền khác nhau cho từng tác tử

Lưu ý: `tools.elevated` là **toàn cục** và dựa trên người gửi; không thể cấu hình theo từng agent.
5. Nếu bạn cần ranh giới theo từng agent, hãy dùng `agents.list[].tools` để từ chối `exec`.
Đối với nhắm mục tiêu theo nhóm, hãy dùng `agents.list[].groupChat.mentionPatterns` để các @mention ánh xạ chính xác tới agent mong muốn.

Xem [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) để có ví dụ chi tiết.
