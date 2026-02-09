---
summary: "Hành vi chat nhóm trên các nền tảng (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Thay đổi hành vi chat nhóm hoặc kiểm soát kích hoạt bằng đề cập
title: "Nhóm"
---

# Nhóm

OpenClaw xử lý chat nhóm một cách nhất quán trên các nền tảng: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Giới thiệu cho người mới (2 phút)

OpenClaw “lives” on your own messaging accounts. There is no separate WhatsApp bot user.
If **you** are in a group, OpenClaw can see that group and respond there.

Hành vi mặc định:

- Nhóm bị hạn chế (`groupPolicy: "allowlist"`).
- Trả lời yêu cầu phải có đề cập trừ khi bạn chủ động tắt kiểm soát đề cập.

Diễn giải: những người gửi trong danh sách cho phép có thể kích hoạt OpenClaw bằng cách đề cập đến nó.

> TL;DR
>
> - **Quyền truy cập DM** được kiểm soát bởi `*.allowFrom`.
> - **Quyền truy cập nhóm** được kiểm soát bởi `*.groupPolicy` + danh sách cho phép (`*.groups`, `*.groupAllowFrom`).
> - **Kích hoạt trả lời** được kiểm soát bởi kiểm soát đề cập (`requireMention`, `/activation`).

Luồng nhanh (điều gì xảy ra với một tin nhắn nhóm):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Luồng tin nhắn nhóm](/images/groups-flow.svg)

Nếu bạn muốn...

| Mục tiêu                                                     | Cần thiết lập                                                         |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| Cho phép mọi nhóm nhưng chỉ trả lời khi @đề cập | `groups: { "*": { requireMention: true } }`                           |
| Tắt toàn bộ trả lời trong nhóm                               | `groupPolicy: "disabled"`                                             |
| Chỉ các nhóm cụ thể                                          | `groups: { "<group-id>": { ... } }` (no `"*"` key) |
| Chỉ bạn mới có thể kích hoạt trong nhóm                      | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`            |

## Khóa phiên

- Phiên nhóm dùng khóa phiên `agent:<agentId>:<channel>:group:<id>` (phòng/kênh dùng `agent:<agentId>:<channel>:channel:<id>`).
- Chủ đề diễn đàn Telegram thêm `:topic:<threadId>` vào ID nhóm để mỗi chủ đề có phiên riêng.
- Chat trực tiếp dùng phiên chính (hoặc theo từng người gửi nếu được cấu hình).
- Heartbeat được bỏ qua cho các phiên nhóm.

## Mẫu: DM cá nhân + nhóm công khai (một tác tử)

Có — cách này hoạt động rất tốt nếu lưu lượng “cá nhân” của bạn là **DM** và lưu lượng “công khai” là **nhóm**.

Why: in single-agent mode, DMs typically land in the **main** session key (`agent:main:main`), while groups always use **non-main** session keys (`agent:main:<channel>:group:<id>`). If you enable sandboxing with `mode: "non-main"`, those group sessions run in Docker while your main DM session stays on-host.

Điều này cho bạn một “bộ não” tác tử (không gian làm việc + bộ nhớ dùng chung), nhưng hai tư thế thực thi:

- **DM**: đầy đủ công cụ (host)
- **Nhóm**: sandbox + công cụ bị hạn chế (Docker)

> If you need truly separate workspaces/personas (“personal” and “public” must never mix), use a second agent + bindings. See [Multi-Agent Routing](/concepts/multi-agent).

Ví dụ (DM chạy trên host, nhóm chạy sandbox + chỉ công cụ nhắn tin):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

Want “groups can only see folder X” instead of “no host access”? Keep `workspaceAccess: "none"` and mount only allowlisted paths into the sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

Liên quan:

- Khóa cấu hình và mặc định: [Cấu hình Gateway](/gateway/configuration#agentsdefaultssandbox)
- Gỡ lỗi vì sao một công cụ bị chặn: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Chi tiết bind mount: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Nhãn hiển thị

- Nhãn UI dùng `displayName` khi có, định dạng là `<channel>:<token>`.
- `#room` được dành cho phòng/kênh; chat nhóm dùng `g-<slug>` (chữ thường, khoảng trắng -> `-`, giữ `#@+._-`).

## Chính sách nhóm

Kiểm soát cách xử lý tin nhắn nhóm/phòng theo từng kênh:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| Chính sách    | Hành vi                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `"open"`      | Nhóm bỏ qua danh sách cho phép; kiểm soát đề cập vẫn áp dụng.        |
| `"disabled"`  | Chặn hoàn toàn mọi tin nhắn nhóm.                                    |
| `"allowlist"` | Chỉ cho phép các nhóm/phòng khớp với danh sách cho phép đã cấu hình. |

Ghi chú:

- `groupPolicy` tách biệt với kiểm soát đề cập (yêu cầu @đề cập).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: dùng `groupAllowFrom` (dự phòng: `allowFrom` tường minh).
- Các giá trị mặc định nằm theo từng subsystem dưới `*.groups."*"`..channels\`.
- Slack: danh sách cho phép dùng `channels.slack.channels`.
- Matrix: allowlist uses `channels.matrix.groups` (room IDs, aliases, or names). Use `channels.matrix.groupAllowFrom` to restrict senders; per-room `users` allowlists are also supported.
- DM nhóm được kiểm soát riêng (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Danh sách cho phép Telegram có thể khớp ID người dùng (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) hoặc username (`"@alice"` hoặc `"alice"`); tiền tố không phân biệt hoa thường.
- Mặc định là `groupPolicy: "allowlist"`; nếu danh sách cho phép nhóm trống, tin nhắn nhóm sẽ bị chặn.

Mô hình tư duy nhanh (thứ tự đánh giá cho tin nhắn nhóm):

1. `groupPolicy` (open/disabled/allowlist)
2. danh sách cho phép nhóm (`*.groups`, `*.groupAllowFrom`, danh sách cho phép theo kênh)
3. kiểm soát đề cập (`requireMention`, `/activation`)

## Kiểm soát đề cập (mặc định)

Group messages require a mention unless overridden per group. Điều này áp dụng cho Telegram, WhatsApp, Slack, Discord và Microsoft Teams.

Trả lời một tin nhắn của bot được tính là một lần nhắc ngầm (khi kênh hỗ trợ metadata trả lời). .historyLimit`(hoặc`channels.<channel>\`

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Ghi chú:

- `mentionPatterns` là các regex không phân biệt hoa thường.
- Các nền tảng có đề cập tường minh vẫn được chấp nhận; pattern chỉ là dự phòng.
- Ghi đè theo tác tử: `agents.list[].groupChat.mentionPatterns` (hữu ích khi nhiều tác tử chia sẻ một nhóm).
- Kiểm soát đề cập chỉ được áp dụng khi có thể phát hiện đề cập (đề cập native hoặc đã cấu hình `mentionPatterns`).
- Mặc định Discord nằm trong `channels.discord.guilds."*"` (có thể ghi đè theo guild/kênh).
- Group history context is wrapped uniformly across channels and is **pending-only** (messages skipped due to mention gating); use `messages.groupChat.historyLimit` for the global default and `channels.<channel>Sử dụng `"_"` để cho phép tất cả các nhóm đồng thời vẫn thiết lập hành vi mention mặc định.`.accounts._.historyLimit`) để ghi đè. Set `0\` to disable.

## Hạn chế công cụ theo nhóm/kênh (tùy chọn)

Một số cấu hình kênh hỗ trợ hạn chế công cụ nào khả dụng **bên trong một nhóm/phòng/kênh cụ thể**.

- `tools`: cho phép/từ chối công cụ cho toàn bộ nhóm.
- `toolsBySender`: ghi đè theo từng người gửi trong nhóm (khóa là ID người gửi/tên người dùng/email/số điện thoại tùy theo kênh). Use `"*"` as a wildcard.

Thứ tự phân giải (cụ thể hơn thắng):

1. khớp `toolsBySender` theo nhóm/kênh
2. `tools` theo nhóm/kênh
3. mặc định (`"*"`) khớp `toolsBySender`
4. mặc định (`"*"`) `tools`

Ví dụ (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

Ghi chú:

- Hạn chế công cụ theo nhóm/kênh được áp dụng bổ sung vào chính sách công cụ toàn cục/tác tử (từ chối vẫn có hiệu lực).
- Một số kênh dùng cách lồng khác cho phòng/kênh (ví dụ: Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Danh sách cho phép nhóm

Khi `channels.whatsapp.groups`, `channels.telegram.groups` hoặc `channels.imessage.groups` được cấu hình, các khóa đóng vai trò như một allowlist nhóm. Nó nhắc mô hình phản hồi như con người, tránh bảng Markdown và tránh gõ các chuỗi `\n` theo nghĩa đen.

Mục đích thường gặp (copy/paste):

1. Tắt toàn bộ trả lời trong nhóm

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Chỉ cho phép các nhóm cụ thể (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. Cho phép mọi nhóm nhưng yêu cầu đề cập (tường minh)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Chỉ chủ sở hữu mới có thể kích hoạt trong nhóm (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Kích hoạt (chỉ chủ sở hữu)

Chủ nhóm có thể bật/tắt kích hoạt theo từng nhóm:

- `/activation mention`
- `/activation always`

Owner is determined by `channels.whatsapp.allowFrom` (or the bot’s self E.164 when unset). Send the command as a standalone message. Other surfaces currently ignore `/activation`.

## Trường ngữ cảnh

Payload đầu vào của nhóm thiết lập:

- `ChatType=group`
- `GroupSubject` (nếu biết)
- `GroupMembers` (nếu biết)
- `WasMentioned` (kết quả kiểm soát đề cập)
- Chủ đề diễn đàn Telegram cũng bao gồm `MessageThreadId` và `IsForum`.

The agent system prompt includes a group intro on the first turn of a new group session. Lịch sử DM có thể được giới hạn bằng `channels.telegram.dmHistoryLimit` (số lượt của người dùng).

## Chi tiết riêng cho iMessage

- Ưu tiên `chat_id:<id>` khi định tuyến hoặc cho phép.
- Liệt kê chat: `imsg chats --limit 20`.
- Trả lời nhóm luôn quay lại cùng `chat_id`.

## Chi tiết riêng cho WhatsApp

Xem [Group messages](/channels/group-messages) để biết hành vi chỉ dành cho WhatsApp (chèn lịch sử, chi tiết xử lý đề cập).
