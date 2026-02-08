---
summary: "Trạng thái hỗ trợ bot Microsoft Teams, khả năng và cấu hình"
read_when:
  - Làm việc trên các tính năng kênh MS Teams
title: "Microsoft Teams"
x-i18n:
  source_path: channels/msteams.md
  source_hash: cec0b5a6eb3ff1ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:00Z
---

# Microsoft Teams (plugin)

> "Hãy từ bỏ mọi hy vọng, hỡi những ai bước vào đây."

Cập nhật: 2026-01-21

Trạng thái: hỗ trợ văn bản + tệp đính kèm DM; gửi tệp trong kênh/nhóm yêu cầu `sharePointSiteId` + quyền Graph (xem [Gửi tệp trong chat nhóm](#sending-files-in-group-chats)). Thăm dò ý kiến được gửi qua Adaptive Cards.

## Plugin bắt buộc

Microsoft Teams được phân phối dưới dạng plugin và không đi kèm bản cài đặt lõi.

**Thay đổi phá vỡ (2026.1.15):** MS Teams đã được tách khỏi lõi. Nếu bạn dùng nó, bạn phải cài plugin.

Giải thích: giúp bản cài lõi gọn nhẹ hơn và cho phép các phụ thuộc của MS Teams cập nhật độc lập.

Cài qua CLI (npm registry):

```bash
openclaw plugins install @openclaw/msteams
```

Checkout cục bộ (khi chạy từ repo git):

```bash
openclaw plugins install ./extensions/msteams
```

Nếu bạn chọn Teams trong quá trình cấu hình/hướng dẫn ban đầu và phát hiện có checkout git,
OpenClaw sẽ tự động đề xuất đường dẫn cài đặt cục bộ.

Chi tiết: [Plugins](/tools/plugin)

## Thiết lập nhanh (cho người mới)

1. Cài plugin Microsoft Teams.
2. Tạo **Azure Bot** (App ID + client secret + tenant ID).
3. Cấu hình OpenClaw với các thông tin xác thực đó.
4. Mở `/api/messages` (mặc định cổng 3978) qua URL công khai hoặc tunnel.
5. Cài gói ứng dụng Teams và khởi động gateway.

Cấu hình tối thiểu:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Lưu ý: chat nhóm bị chặn theo mặc định (`channels.msteams.groupPolicy: "allowlist"`). Để cho phép trả lời nhóm, đặt `channels.msteams.groupAllowFrom` (hoặc dùng `groupPolicy: "open"` để cho phép mọi thành viên, có điều kiện mention).

## Mục tiêu

- Giao tiếp với OpenClaw qua DM Teams, chat nhóm hoặc kênh.
- Giữ định tuyến xác định: phản hồi luôn quay lại đúng kênh đã nhận.
- Mặc định hành vi an toàn cho kênh (yêu cầu mention trừ khi cấu hình khác).

## Ghi cấu hình

Theo mặc định, Microsoft Teams được phép ghi cập nhật cấu hình do `/config set|unset` kích hoạt (yêu cầu `commands.config: true`).

Tắt bằng:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Kiểm soát truy cập (DMs + nhóm)

**Truy cập DM**

- Mặc định: `channels.msteams.dmPolicy = "pairing"`. Người gửi chưa biết sẽ bị bỏ qua cho đến khi được phê duyệt.
- `channels.msteams.allowFrom` chấp nhận AAD object ID, UPN hoặc tên hiển thị. Trình hướng dẫn sẽ phân giải tên sang ID qua Microsoft Graph khi có đủ thông tin xác thực.

**Truy cập nhóm**

- Mặc định: `channels.msteams.groupPolicy = "allowlist"` (bị chặn trừ khi bạn thêm `groupAllowFrom`). Dùng `channels.defaults.groupPolicy` để ghi đè mặc định khi chưa đặt.
- `channels.msteams.groupAllowFrom` kiểm soát người gửi nào có thể kích hoạt trong chat nhóm/kênh (dự phòng về `channels.msteams.allowFrom`).
- Đặt `groupPolicy: "open"` để cho phép mọi thành viên (vẫn yêu cầu mention theo mặc định).
- Để **không cho phép kênh nào**, đặt `channels.msteams.groupPolicy: "disabled"`.

Ví dụ:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + danh sách cho phép kênh**

- Giới hạn phản hồi nhóm/kênh bằng cách liệt kê teams và channels dưới `channels.msteams.teams`.
- Khóa có thể là team ID hoặc tên; khóa kênh có thể là conversation ID hoặc tên.
- Khi `groupPolicy="allowlist"` và có danh sách teams, chỉ các team/kênh được liệt kê mới được chấp nhận (yêu cầu mention).
- Trình cấu hình chấp nhận các mục `Team/Channel` và lưu giúp bạn.
- Khi khởi động, OpenClaw phân giải tên team/kênh và danh sách cho phép người dùng sang ID (khi Graph cho phép)
  và ghi log ánh xạ; các mục không phân giải được sẽ giữ nguyên như đã nhập.

Ví dụ:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Cách hoạt động

1. Cài plugin Microsoft Teams.
2. Tạo **Azure Bot** (App ID + secret + tenant ID).
3. Xây dựng **gói ứng dụng Teams** tham chiếu bot và bao gồm các quyền RSC bên dưới.
4. Tải lên/cài ứng dụng Teams vào một team (hoặc phạm vi cá nhân cho DM).
5. Cấu hình `msteams` trong `~/.openclaw/openclaw.json` (hoặc biến môi trường) và khởi động gateway.
6. Gateway lắng nghe webhook Bot Framework trên `/api/messages` theo mặc định.

## Thiết lập Azure Bot (Điều kiện tiên quyết)

Trước khi cấu hình OpenClaw, bạn cần tạo tài nguyên Azure Bot.

### Bước 1: Tạo Azure Bot

1. Vào [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Điền tab **Basics**:

   | Trường             | Giá trị                                                   |
   | ------------------ | --------------------------------------------------------- |
   | **Bot handle**     | Tên bot của bạn, ví dụ `openclaw-msteams` (phải duy nhất) |
   | **Subscription**   | Chọn subscription Azure                                   |
   | **Resource group** | Tạo mới hoặc dùng sẵn                                     |
   | **Pricing tier**   | **Free** cho dev/test                                     |
   | **Type of App**    | **Single Tenant** (khuyến nghị - xem lưu ý bên dưới)      |
   | **Creation type**  | **Create new Microsoft App ID**                           |

> **Thông báo ngừng dùng:** Việc tạo bot multi-tenant mới đã bị ngừng sau 2025-07-31. Dùng **Single Tenant** cho bot mới.

3. Nhấn **Review + create** → **Create** (chờ ~1-2 phút)

### Bước 2: Lấy thông tin xác thực

1. Vào tài nguyên Azure Bot → **Configuration**
2. Sao chép **Microsoft App ID** → đây là `appId` của bạn
3. Nhấn **Manage Password** → vào App Registration
4. Trong **Certificates & secrets** → **New client secret** → sao chép **Value** → đây là `appPassword`
5. Vào **Overview** → sao chép **Directory (tenant) ID** → đây là `tenantId`

### Bước 3: Cấu hình Messaging Endpoint

1. Trong Azure Bot → **Configuration**
2. Đặt **Messaging endpoint** thành URL webhook của bạn:
   - Production: `https://your-domain.com/api/messages`
   - Dev cục bộ: dùng tunnel (xem [Phát triển cục bộ](#local-development-tunneling) bên dưới)

### Bước 4: Bật kênh Teams

1. Trong Azure Bot → **Channels**
2. Nhấn **Microsoft Teams** → Configure → Save
3. Chấp nhận Điều khoản dịch vụ

## Phát triển cục bộ (Tunneling)

Teams không thể truy cập `localhost`. Dùng tunnel cho phát triển cục bộ:

**Tùy chọn A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Tùy chọn B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Teams Developer Portal (Thay thế)

Thay vì tự tạo manifest ZIP, bạn có thể dùng [Teams Developer Portal](https://dev.teams.microsoft.com/apps):

1. Nhấn **+ New app**
2. Điền thông tin cơ bản (tên, mô tả, thông tin nhà phát triển)
3. Vào **App features** → **Bot**
4. Chọn **Enter a bot ID manually** và dán Azure Bot App ID
5. Chọn phạm vi: **Personal**, **Team**, **Group Chat**
6. Nhấn **Distribute** → **Download app package**
7. Trong Teams: **Apps** → **Manage your apps** → **Upload a custom app** → chọn ZIP

Cách này thường dễ hơn so với chỉnh tay JSON manifest.

## Kiểm thử bot

**Tùy chọn A: Azure Web Chat (xác minh webhook trước)**

1. Azure Portal → tài nguyên Azure Bot → **Test in Web Chat**
2. Gửi tin nhắn – bạn sẽ thấy phản hồi
3. Xác nhận endpoint webhook hoạt động trước khi cấu hình Teams

**Tùy chọn B: Teams (sau khi cài app)**

1. Cài ứng dụng Teams (sideload hoặc org catalog)
2. Tìm bot trong Teams và gửi DM
3. Kiểm tra log gateway để xem hoạt động đến

## Thiết lập (tối thiểu, chỉ văn bản)

1. **Cài plugin Microsoft Teams**
   - Từ npm: `openclaw plugins install @openclaw/msteams`
   - Từ checkout cục bộ: `openclaw plugins install ./extensions/msteams`

2. **Đăng ký bot**
   - Tạo Azure Bot (xem trên) và ghi lại:
     - App ID
     - Client secret (App password)
     - Tenant ID (single-tenant)

3. **Manifest ứng dụng Teams**
   - Bao gồm mục `bot` với `botId = <App ID>`.
   - Phạm vi: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (bắt buộc cho xử lý tệp phạm vi cá nhân).
   - Thêm quyền RSC (bên dưới).
   - Tạo icon: `outline.png` (32x32) và `color.png` (192x192).
   - Nén cả ba tệp: `manifest.json`, `outline.png`, `color.png`.

4. **Cấu hình OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   Bạn cũng có thể dùng biến môi trường thay cho khóa cấu hình:
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Endpoint bot**
   - Đặt Azure Bot Messaging Endpoint thành:
     - `https://<host>:3978/api/messages` (hoặc đường dẫn/cổng bạn chọn).

6. **Chạy gateway**
   - Kênh Teams tự khởi động khi plugin được cài và tồn tại cấu hình `msteams` với thông tin xác thực.

## Ngữ cảnh lịch sử

- `channels.msteams.historyLimit` kiểm soát số lượng tin nhắn kênh/nhóm gần đây được gói vào prompt.
- Dự phòng về `messages.groupChat.historyLimit`. Đặt `0` để tắt (mặc định 50).
- Lịch sử DM có thể giới hạn bằng `channels.msteams.dmHistoryLimit` (số lượt người dùng). Ghi đè theo người dùng: `channels.msteams.dms["<user_id>"].historyLimit`.

## Quyền RSC Teams hiện tại (Manifest)

Đây là các **resourceSpecific permissions** hiện có trong manifest ứng dụng Teams. Chúng chỉ áp dụng trong team/chat nơi app được cài.

**Cho kênh (phạm vi team):**

- `ChannelMessage.Read.Group` (Application) - nhận mọi tin nhắn kênh không cần @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Cho chat nhóm:**

- `ChatMessage.Read.Chat` (Application) - nhận mọi tin nhắn chat nhóm không cần @mention

## Ví dụ Manifest Teams (đã lược bỏ)

Ví dụ tối thiểu, hợp lệ với các trường bắt buộc. Thay ID và URL.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Lưu ý manifest (các trường bắt buộc)

- `bots[].botId` **phải** khớp Azure Bot App ID.
- `webApplicationInfo.id` **phải** khớp Azure Bot App ID.
- `bots[].scopes` phải bao gồm các bề mặt bạn định dùng (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` là bắt buộc để xử lý tệp ở phạm vi cá nhân.
- `authorization.permissions.resourceSpecific` phải bao gồm đọc/gửi kênh nếu bạn muốn lưu lượng kênh.

### Cập nhật ứng dụng hiện có

Để cập nhật ứng dụng Teams đã cài (ví dụ thêm quyền RSC):

1. Cập nhật `manifest.json` với thiết lập mới
2. **Tăng trường `version`** (ví dụ `1.0.0` → `1.1.0`)
3. **Nén lại** manifest với icon (`manifest.json`, `outline.png`, `color.png`)
4. Tải lên zip mới:
   - **Tùy chọn A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → tìm app → Upload new version
   - **Tùy chọn B (Sideload):** Trong Teams → Apps → Manage your apps → Upload a custom app
5. **Với kênh team:** Cài lại app trong từng team để quyền mới có hiệu lực
6. **Thoát hoàn toàn và mở lại Teams** (không chỉ đóng cửa sổ) để xóa cache metadata app

## Khả năng: chỉ RSC vs Graph

### Với **chỉ Teams RSC** (app đã cài, không có quyền Graph API)

Hoạt động:

- Đọc nội dung **văn bản** tin nhắn kênh.
- Gửi nội dung **văn bản** tin nhắn kênh.
- Nhận tệp đính kèm **cá nhân (DM)**.

Không hoạt động:

- **Hình ảnh hoặc nội dung tệp** trong kênh/nhóm (payload chỉ có stub HTML).
- Tải xuống tệp đính kèm lưu trong SharePoint/OneDrive.
- Đọc lịch sử tin nhắn (ngoài sự kiện webhook trực tiếp).

### Với **Teams RSC + quyền Microsoft Graph Application**

Bổ sung:

- Tải nội dung được lưu trữ (ảnh dán trong tin nhắn).
- Tải tệp đính kèm lưu trong SharePoint/OneDrive.
- Đọc lịch sử tin nhắn kênh/chat qua Graph.

### RSC vs Graph API

| Khả năng                    | Quyền RSC         | Graph API                       |
| --------------------------- | ----------------- | ------------------------------- |
| **Tin nhắn thời gian thực** | Có (qua webhook)  | Không (chỉ polling)             |
| **Tin nhắn lịch sử**        | Không             | Có (truy vấn lịch sử)           |
| **Độ phức tạp thiết lập**   | Chỉ manifest app  | Cần admin consent + luồng token |
| **Hoạt động offline**       | Không (phải chạy) | Có (truy vấn bất kỳ lúc nào)    |

**Kết luận:** RSC dùng để lắng nghe thời gian thực; Graph API dùng cho truy cập lịch sử. Để bắt kịp tin nhắn bỏ lỡ khi offline, bạn cần Graph API với `ChannelMessage.Read.All` (yêu cầu admin consent).

## Media + lịch sử dùng Graph (bắt buộc cho kênh)

Nếu bạn cần hình ảnh/tệp trong **kênh** hoặc muốn lấy **lịch sử tin nhắn**, bạn phải bật quyền Microsoft Graph và cấp admin consent.

1. Trong Entra ID (Azure AD) **App Registration**, thêm quyền Microsoft Graph **Application**:
   - `ChannelMessage.Read.All` (tệp đính kèm kênh + lịch sử)
   - `Chat.Read.All` hoặc `ChatMessage.Read.All` (chat nhóm)
2. **Cấp admin consent** cho tenant.
3. Tăng **manifest version** của app Teams, tải lại và **cài lại app trong Teams**.
4. **Thoát hoàn toàn và mở lại Teams** để xóa cache metadata app.

## Giới hạn đã biết

### Hết thời gian webhook

Teams gửi tin nhắn qua webhook HTTP. Nếu xử lý quá lâu (ví dụ phản hồi LLM chậm), bạn có thể thấy:

- Gateway timeout
- Teams gửi lại tin nhắn (gây trùng lặp)
- Mất phản hồi

OpenClaw xử lý bằng cách trả về nhanh và gửi phản hồi chủ động, nhưng phản hồi quá chậm vẫn có thể gây vấn đề.

### Định dạng

Markdown của Teams hạn chế hơn Slack hoặc Discord:

- Định dạng cơ bản hoạt động: **đậm**, _nghiêng_, `code`, liên kết
- Markdown phức tạp (bảng, danh sách lồng nhau) có thể không hiển thị đúng
- Adaptive Cards được hỗ trợ cho thăm dò ý kiến và gửi thẻ tùy ý (xem bên dưới)

## Cấu hình

Các thiết lập chính (xem `/gateway/configuration` cho mẫu kênh dùng chung):

- `channels.msteams.enabled`: bật/tắt kênh.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: thông tin xác thực bot.
- `channels.msteams.webhook.port` (mặc định `3978`)
- `channels.msteams.webhook.path` (mặc định `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (mặc định: pairing)
- `channels.msteams.allowFrom`: danh sách cho phép DM (AAD object ID, UPN hoặc tên hiển thị). Trình hướng dẫn phân giải tên sang ID khi có quyền Graph.
- `channels.msteams.textChunkLimit`: kích thước chia đoạn văn bản gửi ra.
- `channels.msteams.chunkMode`: `length` (mặc định) hoặc `newline` để chia theo dòng trống (ranh giới đoạn) trước khi chia theo độ dài.
- `channels.msteams.mediaAllowHosts`: danh sách cho phép host tệp đính kèm vào (mặc định là domain Microsoft/Teams).
- `channels.msteams.mediaAuthAllowHosts`: danh sách cho phép đính kèm header Authorization khi retry media (mặc định Graph + Bot Framework).
- `channels.msteams.requireMention`: yêu cầu @mention trong kênh/nhóm (mặc định true).
- `channels.msteams.replyStyle`: `thread | top-level` (xem [Kiểu trả lời](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: ghi đè theo team.
- `channels.msteams.teams.<teamId>.requireMention`: ghi đè theo team.
- `channels.msteams.teams.<teamId>.tools`: ghi đè chính sách công cụ theo team mặc định (`allow`/`deny`/`alsoAllow`) dùng khi thiếu ghi đè theo kênh.
- `channels.msteams.teams.<teamId>.toolsBySender`: ghi đè chính sách công cụ theo team theo người gửi (`"*"` hỗ trợ wildcard).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: ghi đè theo kênh.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: ghi đè theo kênh.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: ghi đè chính sách công cụ theo kênh (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: ghi đè chính sách công cụ theo kênh theo người gửi (`"*"` hỗ trợ wildcard).
- `channels.msteams.sharePointSiteId`: SharePoint site ID để tải tệp lên trong chat nhóm/kênh (xem [Gửi tệp trong chat nhóm](#sending-files-in-group-chats)).

## Định tuyến & Phiên

- Khóa phiên theo định dạng tác tử chuẩn (xem [/concepts/session](/concepts/session)):
  - Tin nhắn trực tiếp dùng chung phiên chính (`agent:<agentId>:<mainKey>`).
  - Tin nhắn kênh/nhóm dùng conversation id:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Kiểu trả lời: Threads vs Posts

Teams gần đây giới thiệu hai kiểu UI kênh trên cùng mô hình dữ liệu:

| Kiểu                      | Mô tả                                             | `replyStyle` khuyến nghị |
| ------------------------- | ------------------------------------------------- | ------------------------ |
| **Posts** (cổ điển)       | Tin nhắn dạng thẻ với trả lời theo luồng bên dưới | `thread` (mặc định)      |
| **Threads** (giống Slack) | Tin nhắn hiển thị tuyến tính, giống Slack         | `top-level`              |

**Vấn đề:** API Teams không cho biết kênh dùng kiểu UI nào. Nếu dùng sai `replyStyle`:

- `thread` trong kênh kiểu Threads → trả lời bị lồng khó chịu
- `top-level` trong kênh kiểu Posts → trả lời thành bài đăng cấp cao riêng lẻ

**Giải pháp:** Cấu hình `replyStyle` theo từng kênh dựa trên cách kênh được thiết lập:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## Tệp đính kèm & Hình ảnh

**Giới hạn hiện tại:**

- **DMs:** Hình ảnh và tệp đính kèm hoạt động qua API tệp bot Teams.
- **Kênh/nhóm:** Tệp nằm trong lưu trữ M365 (SharePoint/OneDrive). Payload webhook chỉ có stub HTML, không có byte tệp thực. **Cần quyền Graph API** để tải tệp đính kèm kênh.

Không có quyền Graph, tin nhắn kênh có hình ảnh sẽ chỉ nhận được văn bản (bot không truy cập được nội dung ảnh).
Theo mặc định, OpenClaw chỉ tải media từ hostname Microsoft/Teams. Ghi đè bằng `channels.msteams.mediaAllowHosts` (dùng `["*"]` để cho phép mọi host).
Header Authorization chỉ được đính kèm cho host trong `channels.msteams.mediaAuthAllowHosts` (mặc định Graph + Bot Framework). Giữ danh sách này chặt chẽ (tránh hậu tố multi-tenant).

## Gửi tệp trong chat nhóm

Bot có thể gửi tệp trong DM bằng luồng FileConsentCard (có sẵn). Tuy nhiên, **gửi tệp trong chat nhóm/kênh** cần thiết lập bổ sung:

| Ngữ cảnh                    | Cách gửi tệp                                         | Thiết lập cần thiết                  |
| --------------------------- | ---------------------------------------------------- | ------------------------------------ |
| **DMs**                     | FileConsentCard → người dùng chấp nhận → bot tải lên | Hoạt động sẵn                        |
| **Chat nhóm/kênh**          | Tải lên SharePoint → chia sẻ liên kết                | Cần `sharePointSiteId` + quyền Graph |
| **Hình ảnh (mọi ngữ cảnh)** | Inline mã hóa Base64                                 | Hoạt động sẵn                        |

### Vì sao chat nhóm cần SharePoint

Bot không có ổ OneDrive cá nhân (endpoint Graph API `/me/drive` không hoạt động cho identity ứng dụng). Để gửi tệp trong chat nhóm/kênh, bot tải lên **SharePoint site** và tạo liên kết chia sẻ.

### Thiết lập

1. **Thêm quyền Graph API** trong Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) - tải tệp lên SharePoint
   - `Chat.Read.All` (Application) - tùy chọn, bật liên kết chia sẻ theo người dùng

2. **Cấp admin consent** cho tenant.

3. **Lấy SharePoint site ID:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Cấu hình OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Hành vi chia sẻ

| Quyền                                   | Hành vi chia sẻ                                            |
| --------------------------------------- | ---------------------------------------------------------- |
| `Sites.ReadWrite.All` only              | Liên kết chia sẻ toàn tổ chức (ai trong org cũng truy cập) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Liên kết chia sẻ theo người dùng (chỉ thành viên chat)     |

Chia sẻ theo người dùng an toàn hơn vì chỉ người tham gia chat mới truy cập được tệp. Nếu thiếu quyền `Chat.Read.All`, bot sẽ dùng chia sẻ toàn tổ chức.

### Hành vi dự phòng

| Kịch bản                                      | Kết quả                                                 |
| --------------------------------------------- | ------------------------------------------------------- |
| Chat nhóm + tệp + cấu hình `sharePointSiteId` | Tải lên SharePoint, gửi liên kết chia sẻ                |
| Chat nhóm + tệp + không có `sharePointSiteId` | Thử tải lên OneDrive (có thể thất bại), chỉ gửi văn bản |
| Chat cá nhân + tệp                            | Luồng FileConsentCard (không cần SharePoint)            |
| Mọi ngữ cảnh + hình ảnh                       | Inline mã hóa Base64 (không cần SharePoint)             |

### Vị trí lưu tệp

Các tệp tải lên được lưu trong thư mục `/OpenClawShared/` của thư viện tài liệu mặc định trên SharePoint site đã cấu hình.

## Thăm dò ý kiến (Adaptive Cards)

OpenClaw gửi thăm dò Teams dưới dạng Adaptive Cards (không có API thăm dò Teams gốc).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Phiếu bầu được gateway ghi trong `~/.openclaw/msteams-polls.json`.
- Gateway phải luôn online để ghi nhận phiếu.
- Thăm dò chưa tự động đăng tổng kết kết quả (xem tệp lưu trữ nếu cần).

## Adaptive Cards (tùy ý)

Gửi bất kỳ JSON Adaptive Card nào tới người dùng hoặc hội thoại Teams bằng công cụ `message` hoặc CLI.

Tham số `card` nhận một đối tượng JSON Adaptive Card. Khi cung cấp `card`, văn bản tin nhắn là tùy chọn.

**Công cụ tác tử:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

Xem [tài liệu Adaptive Cards](https://adaptivecards.io/) để biết schema và ví dụ. Với chi tiết định dạng đích, xem [Định dạng đích](#target-formats) bên dưới.

## Định dạng đích

Đích MSTeams dùng tiền tố để phân biệt người dùng và hội thoại:

| Loại đích             | Định dạng                        | Ví dụ                                            |
| --------------------- | -------------------------------- | ------------------------------------------------ |
| Người dùng (theo ID)  | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`      |
| Người dùng (theo tên) | `user:<display-name>`            | `user:John Smith` (cần Graph API)                |
| Nhóm/kênh             | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`         |
| Nhóm/kênh (raw)       | `<conversation-id>`              | `19:abc123...@thread.tacv2` (nếu chứa `@thread`) |

**Ví dụ CLI:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Ví dụ công cụ tác tử:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

Lưu ý: Không có tiền tố `user:`, tên mặc định sẽ phân giải theo nhóm/team. Luôn dùng `user:` khi nhắm tới người theo tên hiển thị.

## Nhắn tin chủ động

- Nhắn tin chủ động chỉ có thể thực hiện **sau khi** người dùng đã tương tác, vì lúc đó chúng tôi lưu conversation reference.
- Xem `/gateway/configuration` cho `dmPolicy` và điều kiện danh sách cho phép.

## Team và Channel ID (Lỗi thường gặp)

Tham số truy vấn `groupId` trong URL Teams **KHÔNG** phải team ID dùng cho cấu hình. Hãy trích ID từ đường dẫn URL:

**URL Team:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**URL Channel:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Cho cấu hình:**

- Team ID = đoạn đường dẫn sau `/team/` (URL-decoded, ví dụ `19:Bk4j...@thread.tacv2`)
- Channel ID = đoạn đường dẫn sau `/channel/` (URL-decoded)
- **Bỏ qua** tham số truy vấn `groupId`

## Kênh riêng tư

Bot hỗ trợ hạn chế trong kênh riêng tư:

| Tính năng                         | Kênh chuẩn | Kênh riêng tư          |
| --------------------------------- | ---------- | ---------------------- |
| Cài đặt bot                       | Có         | Hạn chế                |
| Tin nhắn thời gian thực (webhook) | Có         | Có thể không hoạt động |
| Quyền RSC                         | Có         | Có thể khác biệt       |
| @mentions                         | Có         | Nếu bot truy cập được  |
| Lịch sử Graph API                 | Có         | Có (có quyền)          |

**Giải pháp nếu kênh riêng tư không hoạt động:**

1. Dùng kênh chuẩn cho tương tác bot
2. Dùng DM – người dùng luôn có thể nhắn trực tiếp cho bot
3. Dùng Graph API cho truy cập lịch sử (yêu cầu `ChannelMessage.Read.All`)

## Xử lý sự cố

### Sự cố thường gặp

- **Không thấy hình ảnh trong kênh:** Thiếu quyền Graph hoặc admin consent. Cài lại app Teams và thoát/mở lại Teams hoàn toàn.
- **Không có phản hồi trong kênh:** Mặc định yêu cầu mention; đặt `channels.msteams.requireMention=false` hoặc cấu hình theo team/kênh.
- **Lệch phiên bản (Teams vẫn hiển thị manifest cũ):** Gỡ + thêm lại app và thoát/mở lại Teams để làm mới.
- **401 Unauthorized từ webhook:** Dự kiến khi test thủ công không có Azure JWT – nghĩa là endpoint truy cập được nhưng xác thực thất bại. Dùng Azure Web Chat để test đúng cách.

### Lỗi tải manifest

- **"Icon file cannot be empty":** Manifest tham chiếu icon 0 byte. Tạo PNG hợp lệ (32x32 cho `outline.png`, 192x192 cho `color.png`).
- **"webApplicationInfo.Id already in use":** App vẫn đang được cài ở team/chat khác. Gỡ trước hoặc chờ 5–10 phút để lan truyền.
- **"Something went wrong" khi tải:** Thử tải qua [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com), mở DevTools (F12) → tab Network, kiểm tra response body để biết lỗi thực.
- **Sideload thất bại:** Thử “Upload an app to your org's app catalog” thay vì “Upload a custom app” – thường vượt qua hạn chế sideload.

### Quyền RSC không hoạt động

1. Xác minh `webApplicationInfo.id` khớp chính xác App ID của bot
2. Tải lại app và cài lại trong team/chat
3. Kiểm tra admin org có chặn quyền RSC không
4. Xác nhận dùng đúng phạm vi: `ChannelMessage.Read.Group` cho teams, `ChatMessage.Read.Chat` cho chat nhóm

## Tham khảo

- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Hướng dẫn thiết lập Azure Bot
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - tạo/quản lý ứng dụng Teams
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Receive channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams bot file handling](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (kênh/nhóm cần Graph)
- [Proactive messaging](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
