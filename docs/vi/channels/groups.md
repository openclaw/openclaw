---
summary: "Hành vi chat nhóm trên các nền tảng (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Thay đổi hành vi chat nhóm hoặc kiểm soát kích hoạt bằng đề cập
title: "Nhóm"
x-i18n:
  source_path: channels/groups.md
  source_hash: 5380e07ea01f4a8f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:12Z
---

# Nhóm

OpenClaw xử lý chat nhóm một cách nhất quán trên các nền tảng: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams.

## Giới thiệu cho người mới (2 phút)

OpenClaw “sống” trên chính các tài khoản nhắn tin của bạn. Không có người dùng bot WhatsApp riêng biệt.
Nếu **bạn** ở trong một nhóm, OpenClaw có thể nhìn thấy nhóm đó và trả lời ngay tại đó.

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

| Mục tiêu                                        | Cần thiết lập                                              |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Cho phép mọi nhóm nhưng chỉ trả lời khi @đề cập | `groups: { "*": { requireMention: true } }`                |
| Tắt toàn bộ trả lời trong nhóm                  | `groupPolicy: "disabled"`                                  |
| Chỉ các nhóm cụ thể                             | `groups: { "<group-id>": { ... } }` (không có khóa `"*"`)  |
| Chỉ bạn mới có thể kích hoạt trong nhóm         | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## Khóa phiên

- Phiên nhóm dùng khóa phiên `agent:<agentId>:<channel>:group:<id>` (phòng/kênh dùng `agent:<agentId>:<channel>:channel:<id>`).
- Chủ đề diễn đàn Telegram thêm `:topic:<threadId>` vào ID nhóm để mỗi chủ đề có phiên riêng.
- Chat trực tiếp dùng phiên chính (hoặc theo từng người gửi nếu được cấu hình).
- Heartbeat được bỏ qua cho các phiên nhóm.

## Mẫu: DM cá nhân + nhóm công khai (một tác tử)

Có — cách này hoạt động rất tốt nếu lưu lượng “cá nhân” của bạn là **DM** và lưu lượng “công khai” là **nhóm**.

Lý do: ở chế độ một tác tử, DM thường rơi vào khóa phiên **chính** (`agent:main:main`), trong khi nhóm luôn dùng các khóa phiên **không phải chính** (`agent:main:<channel>:group:<id>`). Nếu bạn bật sandboxing với `mode: "non-main"`, các phiên nhóm sẽ chạy trong Docker còn phiên DM chính vẫn chạy trên máy chủ.

Điều này cho bạn một “bộ não” tác tử (không gian làm việc + bộ nhớ dùng chung), nhưng hai tư thế thực thi:

- **DM**: đầy đủ công cụ (host)
- **Nhóm**: sandbox + công cụ bị hạn chế (Docker)

> Nếu bạn cần các không gian làm việc/nhân dạng thực sự tách biệt (“cá nhân” và “công khai” không bao giờ được trộn), hãy dùng tác tử thứ hai + bindings. Xem [Multi-Agent Routing](/concepts/multi-agent).

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

Muốn “nhóm chỉ thấy thư mục X” thay vì “không có quyền truy cập host”? Giữ `workspaceAccess: "none"` và chỉ mount các đường dẫn trong danh sách cho phép vào sandbox:

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

| Chính sách    | Hành vi                                                              |
| ------------- | -------------------------------------------------------------------- |
| `"open"`      | Nhóm bỏ qua danh sách cho phép; kiểm soát đề cập vẫn áp dụng.        |
| `"disabled"`  | Chặn hoàn toàn mọi tin nhắn nhóm.                                    |
| `"allowlist"` | Chỉ cho phép các nhóm/phòng khớp với danh sách cho phép đã cấu hình. |

Ghi chú:

- `groupPolicy` tách biệt với kiểm soát đề cập (yêu cầu @đề cập).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: dùng `groupAllowFrom` (dự phòng: `allowFrom` tường minh).
- Discord: danh sách cho phép dùng `channels.discord.guilds.<id>.channels`.
- Slack: danh sách cho phép dùng `channels.slack.channels`.
- Matrix: danh sách cho phép dùng `channels.matrix.groups` (ID phòng, bí danh hoặc tên). Dùng `channels.matrix.groupAllowFrom` để hạn chế người gửi; danh sách cho phép theo từng phòng `users` cũng được hỗ trợ.
- DM nhóm được kiểm soát riêng (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Danh sách cho phép Telegram có thể khớp ID người dùng (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) hoặc username (`"@alice"` hoặc `"alice"`); tiền tố không phân biệt hoa thường.
- Mặc định là `groupPolicy: "allowlist"`; nếu danh sách cho phép nhóm trống, tin nhắn nhóm sẽ bị chặn.

Mô hình tư duy nhanh (thứ tự đánh giá cho tin nhắn nhóm):

1. `groupPolicy` (open/disabled/allowlist)
2. danh sách cho phép nhóm (`*.groups`, `*.groupAllowFrom`, danh sách cho phép theo kênh)
3. kiểm soát đề cập (`requireMention`, `/activation`)

## Kiểm soát đề cập (mặc định)

Tin nhắn nhóm yêu cầu có đề cập trừ khi bị ghi đè theo từng nhóm. Mặc định nằm theo từng subsystem dưới `*.groups."*"`.

Trả lời một tin nhắn của bot được tính là đề cập ngầm (khi kênh hỗ trợ metadata trả lời). Áp dụng cho Telegram, WhatsApp, Slack, Discord và Microsoft Teams.

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
- Ngữ cảnh lịch sử nhóm được bọc thống nhất trên các kênh và là **chỉ các tin đang chờ** (những tin bị bỏ qua do kiểm soát đề cập); dùng `messages.groupChat.historyLimit` cho mặc định toàn cục và `channels.<channel>.historyLimit` (hoặc `channels.<channel>.accounts.*.historyLimit`) cho ghi đè. Đặt `0` để tắt.

## Hạn chế công cụ theo nhóm/kênh (tùy chọn)

Một số cấu hình kênh hỗ trợ hạn chế công cụ nào khả dụng **bên trong một nhóm/phòng/kênh cụ thể**.

- `tools`: cho phép/từ chối công cụ cho toàn bộ nhóm.
- `toolsBySender`: ghi đè theo từng người gửi trong nhóm (khóa là ID người gửi/username/email/số điện thoại tùy kênh). Dùng `"*"` làm wildcard.

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

Khi `channels.whatsapp.groups`, `channels.telegram.groups` hoặc `channels.imessage.groups` được cấu hình, các khóa này hoạt động như danh sách cho phép nhóm. Dùng `"*"` để cho phép mọi nhóm trong khi vẫn thiết lập hành vi đề cập mặc định.

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

Chủ sở hữu được xác định bởi `channels.whatsapp.allowFrom` (hoặc E.164 của chính bot khi chưa đặt). Gửi lệnh như một tin nhắn độc lập. Các nền tảng khác hiện bỏ qua `/activation`.

## Trường ngữ cảnh

Payload đầu vào của nhóm thiết lập:

- `ChatType=group`
- `GroupSubject` (nếu biết)
- `GroupMembers` (nếu biết)
- `WasMentioned` (kết quả kiểm soát đề cập)
- Chủ đề diễn đàn Telegram cũng bao gồm `MessageThreadId` và `IsForum`.

System prompt của tác tử bao gồm phần giới thiệu nhóm ở lượt đầu của một phiên nhóm mới. Nó nhắc mô hình trả lời như con người, tránh bảng Markdown và tránh gõ các chuỗi `\n` theo nghĩa đen.

## Chi tiết riêng cho iMessage

- Ưu tiên `chat_id:<id>` khi định tuyến hoặc cho phép.
- Liệt kê chat: `imsg chats --limit 20`.
- Trả lời nhóm luôn quay lại cùng `chat_id`.

## Chi tiết riêng cho WhatsApp

Xem [Group messages](/channels/group-messages) để biết hành vi chỉ dành cho WhatsApp (chèn lịch sử, chi tiết xử lý đề cập).
