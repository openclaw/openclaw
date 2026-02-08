---
summary: "Tổng quan bot Feishu, tính năng và cấu hình"
read_when:
  - Bạn muốn kết nối một bot Feishu/Lark
  - Bạn đang cấu hình kênh Feishu
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:11Z
---

# Bot Feishu

Feishu (Lark) là nền tảng chat nhóm được các công ty sử dụng cho nhắn tin và cộng tác. Plugin này kết nối OpenClaw với một bot Feishu/Lark bằng cơ chế đăng ký sự kiện WebSocket của nền tảng, cho phép nhận tin nhắn mà không cần mở URL webhook công khai.

---

## Plugin cần thiết

Cài đặt plugin Feishu:

```bash
openclaw plugins install @openclaw/feishu
```

Checkout cục bộ (khi chạy từ repo git):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Khởi động nhanh

Có hai cách để thêm kênh Feishu:

### Cách 1: trình hướng dẫn onboarding (khuyến nghị)

Nếu bạn vừa cài OpenClaw, hãy chạy trình hướng dẫn:

```bash
openclaw onboard
```

Trình hướng dẫn sẽ giúp bạn:

1. Tạo ứng dụng Feishu và thu thập thông tin xác thực
2. Cấu hình thông tin ứng dụng trong OpenClaw
3. Khởi động gateway

✅ **Sau khi cấu hình**, kiểm tra trạng thái gateway:

- `openclaw gateway status`
- `openclaw logs --follow`

### Cách 2: thiết lập bằng CLI

Nếu bạn đã hoàn tất cài đặt ban đầu, hãy thêm kênh qua CLI:

```bash
openclaw channels add
```

Chọn **Feishu**, sau đó nhập App ID và App Secret.

✅ **Sau khi cấu hình**, quản lý gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Bước 1: Tạo ứng dụng Feishu

### 1. Mở Feishu Open Platform

Truy cập [Feishu Open Platform](https://open.feishu.cn/app) và đăng nhập.

Tenant Lark (toàn cầu) nên dùng [https://open.larksuite.com/app](https://open.larksuite.com/app) và đặt `domain: "lark"` trong cấu hình Feishu.

### 2. Tạo ứng dụng

1. Nhấn **Create enterprise app**
2. Điền tên ứng dụng + mô tả
3. Chọn biểu tượng ứng dụng

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Sao chép thông tin xác thực

Trong **Credentials & Basic Info**, sao chép:

- **App ID** (định dạng: `cli_xxx`)
- **App Secret**

❗ **Quan trọng:** giữ App Secret ở chế độ riêng tư.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Cấu hình quyền

Trong **Permissions**, nhấn **Batch import** và dán:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Bật khả năng bot

Trong **App Capability** > **Bot**:

1. Bật khả năng bot
2. Đặt tên bot

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Cấu hình đăng ký sự kiện

⚠️ **Quan trọng:** trước khi thiết lập đăng ký sự kiện, hãy đảm bảo:

1. Bạn đã chạy `openclaw channels add` cho Feishu
2. Gateway đang chạy (`openclaw gateway status`)

Trong **Event Subscription**:

1. Chọn **Use long connection to receive events** (WebSocket)
2. Thêm sự kiện: `im.message.receive_v1`

⚠️ Nếu gateway không chạy, cấu hình long connection có thể không lưu được.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Phát hành ứng dụng

1. Tạo phiên bản trong **Version Management & Release**
2. Gửi xét duyệt và phát hành
3. Chờ quản trị viên phê duyệt (ứng dụng doanh nghiệp thường tự động phê duyệt)

---

## Bước 2: Cấu hình OpenClaw

### Cấu hình bằng trình hướng dẫn (khuyến nghị)

```bash
openclaw channels add
```

Chọn **Feishu** và dán App ID + App Secret của bạn.

### Cấu hình qua file cấu hình

Chỉnh sửa `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "My AI assistant",
        },
      },
    },
  },
}
```

### Cấu hình qua biến môi trường

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Miền Lark (toàn cầu)

Nếu tenant của bạn dùng Lark (quốc tế), hãy đặt miền thành `lark` (hoặc một chuỗi miền đầy đủ). Bạn có thể đặt tại `channels.feishu.domain` hoặc theo từng tài khoản (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Bước 3: Khởi động + kiểm tra

### 1. Khởi động gateway

```bash
openclaw gateway
```

### 2. Gửi tin nhắn thử

Trong Feishu, tìm bot của bạn và gửi một tin nhắn.

### 3. Phê duyệt ghép cặp

Theo mặc định, bot sẽ trả lời bằng mã ghép cặp. Hãy phê duyệt:

```bash
openclaw pairing approve feishu <CODE>
```

Sau khi phê duyệt, bạn có thể trò chuyện bình thường.

---

## Tổng quan

- **Kênh bot Feishu**: bot Feishu được gateway quản lý
- **Định tuyến xác định**: phản hồi luôn quay lại Feishu
- **Cô lập phiên**: DM dùng chung một phiên chính; nhóm được tách riêng
- **Kết nối WebSocket**: kết nối dài qua SDK Feishu, không cần URL công khai

---

## Kiểm soát truy cập

### Tin nhắn trực tiếp (DM)

- **Mặc định**: `dmPolicy: "pairing"` (người dùng chưa biết sẽ nhận mã ghép cặp)
- **Phê duyệt ghép cặp**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Chế độ allowlist**: đặt `channels.feishu.allowFrom` với danh sách Open ID được phép

### Chat nhóm

**1. Chính sách nhóm** (`channels.feishu.groupPolicy`):

- `"open"` = cho phép mọi người trong nhóm (mặc định)
- `"allowlist"` = chỉ cho phép `groupAllowFrom`
- `"disabled"` = tắt tin nhắn nhóm

**2. Yêu cầu mention** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = yêu cầu @mention (mặc định)
- `false` = phản hồi không cần mention

---

## Ví dụ cấu hình nhóm

### Cho phép tất cả nhóm, yêu cầu @mention (mặc định)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Cho phép tất cả nhóm, không cần @mention

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Chỉ cho phép người dùng cụ thể trong nhóm

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Lấy ID nhóm/người dùng

### ID nhóm (chat_id)

ID nhóm có dạng `oc_xxx`.

**Cách 1 (khuyến nghị)**

1. Khởi động gateway và @mention bot trong nhóm
2. Chạy `openclaw logs --follow` và tìm `chat_id`

**Cách 2**

Dùng công cụ debug API của Feishu để liệt kê các chat nhóm.

### ID người dùng (open_id)

ID người dùng có dạng `ou_xxx`.

**Cách 1 (khuyến nghị)**

1. Khởi động gateway và DM bot
2. Chạy `openclaw logs --follow` và tìm `open_id`

**Cách 2**

Kiểm tra các yêu cầu ghép cặp để lấy Open ID người dùng:

```bash
openclaw pairing list feishu
```

---

## Lệnh thường dùng

| Lệnh      | Mô tả                   |
| --------- | ----------------------- |
| `/status` | Hiển thị trạng thái bot |
| `/reset`  | Đặt lại phiên           |
| `/model`  | Hiển thị/chuyển mô hình |

> Lưu ý: Feishu hiện chưa hỗ trợ menu lệnh gốc, vì vậy lệnh phải được gửi dưới dạng văn bản.

## Lệnh quản lý Gateway

| Lệnh                       | Mô tả                             |
| -------------------------- | --------------------------------- |
| `openclaw gateway status`  | Hiển thị trạng thái gateway       |
| `openclaw gateway install` | Cài đặt/khởi động dịch vụ gateway |
| `openclaw gateway stop`    | Dừng dịch vụ gateway              |
| `openclaw gateway restart` | Khởi động lại dịch vụ gateway     |
| `openclaw logs --follow`   | Theo dõi log gateway              |

---

## Xử lý sự cố

### Bot không phản hồi trong chat nhóm

1. Đảm bảo bot đã được thêm vào nhóm
2. Đảm bảo bạn @mention bot (hành vi mặc định)
3. Kiểm tra `groupPolicy` không được đặt thành `"disabled"`
4. Kiểm tra log: `openclaw logs --follow`

### Bot không nhận được tin nhắn

1. Đảm bảo ứng dụng đã được phát hành và phê duyệt
2. Đảm bảo đăng ký sự kiện bao gồm `im.message.receive_v1`
3. Đảm bảo **long connection** được bật
4. Đảm bảo quyền ứng dụng đã đầy đủ
5. Đảm bảo gateway đang chạy: `openclaw gateway status`
6. Kiểm tra log: `openclaw logs --follow`

### Lộ App Secret

1. Đặt lại App Secret trong Feishu Open Platform
2. Cập nhật App Secret trong cấu hình của bạn
3. Khởi động lại gateway

### Gửi tin nhắn thất bại

1. Đảm bảo ứng dụng có quyền `im:message:send_as_bot`
2. Đảm bảo ứng dụng đã được phát hành
3. Kiểm tra log để xem lỗi chi tiết

---

## Cấu hình nâng cao

### Nhiều tài khoản

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Giới hạn tin nhắn

- `textChunkLimit`: kích thước chia nhỏ văn bản gửi đi (mặc định: 2000 ký tự)
- `mediaMaxMb`: giới hạn tải lên/tải xuống media (mặc định: 30MB)

### Streaming

Feishu hỗ trợ phản hồi streaming qua thẻ tương tác. Khi bật, bot sẽ cập nhật thẻ trong khi tạo văn bản.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Đặt `streaming: false` để chờ phản hồi đầy đủ trước khi gửi.

### Định tuyến đa tác tử

Dùng `bindings` để định tuyến DM hoặc nhóm Feishu đến các tác tử khác nhau.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Các trường định tuyến:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"dm"` hoặc `"group"`
- `match.peer.id`: Open ID người dùng (`ou_xxx`) hoặc ID nhóm (`oc_xxx`)

Xem [Lấy ID nhóm/người dùng](#get-groupuser-ids) để biết mẹo tra cứu.

---

## Tham chiếu cấu hình

Cấu hình đầy đủ: [Gateway configuration](/gateway/configuration)

Các tùy chọn chính:

| Thiết lập                                         | Mô tả                            | Mặc định  |
| ------------------------------------------------- | -------------------------------- | --------- |
| `channels.feishu.enabled`                         | Bật/tắt kênh                     | `true`    |
| `channels.feishu.domain`                          | Miền API (`feishu` hoặc `lark`)  | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | App ID                           | -         |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                       | -         |
| `channels.feishu.accounts.<id>.domain`            | Ghi đè miền API theo tài khoản   | `feishu`  |
| `channels.feishu.dmPolicy`                        | Chính sách DM                    | `pairing` |
| `channels.feishu.allowFrom`                       | Allowlist DM (danh sách open_id) | -         |
| `channels.feishu.groupPolicy`                     | Chính sách nhóm                  | `open`    |
| `channels.feishu.groupAllowFrom`                  | Allowlist nhóm                   | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | Yêu cầu @mention                 | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | Bật nhóm                         | `true`    |
| `channels.feishu.textChunkLimit`                  | Kích thước chia nhỏ tin nhắn     | `2000`    |
| `channels.feishu.mediaMaxMb`                      | Giới hạn kích thước media        | `30`      |
| `channels.feishu.streaming`                       | Bật xuất thẻ streaming           | `true`    |
| `channels.feishu.blockStreaming`                  | Bật block streaming              | `true`    |

---

## Tham chiếu dmPolicy

| Giá trị       | Hành vi                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `"pairing"`   | **Mặc định.** Người dùng chưa biết sẽ nhận mã ghép cặp; cần được phê duyệt |
| `"allowlist"` | Chỉ người dùng trong `allowFrom` mới có thể chat                           |
| `"open"`      | Cho phép tất cả người dùng (yêu cầu `"*"` trong allowFrom)                 |
| `"disabled"`  | Tắt DM                                                                     |

---

## Các loại tin nhắn được hỗ trợ

### Nhận

- ✅ Văn bản
- ✅ Văn bản giàu định dạng (post)
- ✅ Hình ảnh
- ✅ Tệp
- ✅ Âm thanh
- ✅ Video
- ✅ Sticker

### Gửi

- ✅ Văn bản
- ✅ Hình ảnh
- ✅ Tệp
- ✅ Âm thanh
- ⚠️ Văn bản giàu định dạng (hỗ trợ một phần)
