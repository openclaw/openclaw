---
summary: "Thông điệp thăm dò heartbeat và các quy tắc thông báo"
read_when:
  - Điều chỉnh nhịp heartbeat hoặc nội dung thông điệp
  - Quyết định giữa heartbeat và cron cho các tác vụ theo lịch
title: "Heartbeat"
x-i18n:
  source_path: gateway/heartbeat.md
  source_hash: e763caf86ef74488
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:24Z
---

# Heartbeat (Gateway)

> **Heartbeat hay Cron?** Xem [Cron vs Heartbeat](/automation/cron-vs-heartbeat) để biết khi nào nên dùng từng loại.

Heartbeat chạy **các lượt tác tử định kỳ** trong phiên chính để mô hình có thể
phát hiện mọi thứ cần chú ý mà không làm phiền bạn bằng quá nhiều thông báo.

Xử lý sự cố: [/automation/troubleshooting](/automation/troubleshooting)

## Khởi động nhanh (cho người mới)

1. Giữ heartbeat được bật (mặc định là `30m`, hoặc `1h` cho Anthropic OAuth/setup-token) hoặc đặt nhịp riêng của bạn.
2. Tạo một checklist `HEARTBEAT.md` nhỏ trong workspace của tác tử (tùy chọn nhưng khuyến nghị).
3. Quyết định nơi thông điệp heartbeat sẽ được gửi (`target: "last"` là mặc định).
4. Tùy chọn: bật gửi reasoning của heartbeat để tăng tính minh bạch.
5. Tùy chọn: giới hạn heartbeat trong giờ hoạt động (giờ địa phương).

Ví dụ cấu hình:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Mặc định

- Khoảng thời gian: `30m` (hoặc `1h` khi Anthropic OAuth/setup-token là chế độ xác thực được phát hiện). Đặt `agents.defaults.heartbeat.every` hoặc theo từng tác tử `agents.list[].heartbeat.every`; dùng `0m` để tắt.
- Nội dung prompt (có thể cấu hình qua `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- Prompt heartbeat được gửi **nguyên văn** như thông điệp người dùng. Prompt hệ thống
  bao gồm một mục “Heartbeat” và lượt chạy được gắn cờ nội bộ.
- Giờ hoạt động (`heartbeat.activeHours`) được kiểm tra theo múi giờ đã cấu hình.
  Ngoài khung giờ này, heartbeat sẽ bị bỏ qua cho đến nhịp tiếp theo trong khung giờ.

## Mục đích của prompt heartbeat

Prompt mặc định được thiết kế có chủ ý là rộng:

- **Tác vụ nền**: “Consider outstanding tasks” thúc đẩy tác tử rà soát
  các việc theo dõi (hộp thư đến, lịch, nhắc việc, công việc xếp hàng) và nêu bật điều gì đó khẩn cấp.
- **Check-in với con người**: “Checkup sometimes on your human during day time” gợi ý
  một thông điệp nhẹ kiểu “bạn có cần gì không?” thỉnh thoảng, nhưng tránh spam ban đêm
  bằng cách dùng múi giờ địa phương đã cấu hình (xem [/concepts/timezone](/concepts/timezone)).

Nếu bạn muốn heartbeat làm một việc rất cụ thể (ví dụ: “check Gmail PubSub
stats” hoặc “verify gateway health”), hãy đặt `agents.defaults.heartbeat.prompt` (hoặc
`agents.list[].heartbeat.prompt`) thành nội dung tùy chỉnh (được gửi nguyên văn).

## Hợp đồng phản hồi

- Nếu không có gì cần chú ý, trả lời bằng **`HEARTBEAT_OK`**.
- Trong các lượt heartbeat, OpenClaw coi `HEARTBEAT_OK` là một ack khi nó xuất hiện
  ở **đầu hoặc cuối** phản hồi. Token này sẽ bị loại bỏ và phản hồi sẽ bị
  loại nếu nội dung còn lại **≤ `ackMaxChars`** (mặc định: 300).
- Nếu `HEARTBEAT_OK` xuất hiện ở **giữa** phản hồi, nó không được xử lý đặc biệt.
- Với cảnh báo, **không** bao gồm `HEARTBEAT_OK`; chỉ trả về văn bản cảnh báo.

Ngoài heartbeat, các `HEARTBEAT_OK` lạc chỗ ở đầu/cuối thông điệp sẽ bị loại bỏ
và ghi log; một thông điệp chỉ gồm `HEARTBEAT_OK` sẽ bị loại.

## Cấu hình

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Phạm vi và thứ tự ưu tiên

- `agents.defaults.heartbeat` đặt hành vi heartbeat toàn cục.
- `agents.list[].heartbeat` được gộp chồng lên; nếu bất kỳ tác tử nào có khối `heartbeat`, **chỉ những tác tử đó** chạy heartbeat.
- `channels.defaults.heartbeat` đặt mặc định hiển thị cho tất cả các kênh.
- `channels.<channel>.heartbeat` ghi đè mặc định theo kênh.
- `channels.<channel>.accounts.<id>.heartbeat` (kênh đa tài khoản) ghi đè cài đặt theo kênh.

### Heartbeat theo từng tác tử

Nếu bất kỳ mục `agents.list[]` nào bao gồm một khối `heartbeat`, **chỉ những tác tử đó**
chạy heartbeat. Khối theo tác tử sẽ được gộp chồng lên `agents.defaults.heartbeat`
(vì vậy bạn có thể đặt mặc định dùng chung một lần và ghi đè theo tác tử).

Ví dụ: hai tác tử, chỉ tác tử thứ hai chạy heartbeat.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Ví dụ giờ hoạt động

Giới hạn heartbeat trong giờ làm việc theo một múi giờ cụ thể:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Ngoài khung giờ này (trước 9 giờ sáng hoặc sau 10 giờ tối theo giờ Eastern), heartbeat sẽ bị bỏ qua. Nhịp đã lên lịch tiếp theo trong khung giờ sẽ chạy bình thường.

### Ví dụ đa tài khoản

Dùng `accountId` để nhắm tới một tài khoản cụ thể trên các kênh đa tài khoản như Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Ghi chú trường

- `every`: khoảng thời gian heartbeat (chuỗi thời lượng; đơn vị mặc định = phút).
- `model`: ghi đè mô hình tùy chọn cho các lượt heartbeat (`provider/model`).
- `includeReasoning`: khi bật, cũng gửi thông điệp `Reasoning:` riêng khi khả dụng (cùng dạng với `/reasoning on`).
- `session`: khóa phiên tùy chọn cho các lượt heartbeat.
  - `main` (mặc định): phiên chính của tác tử.
  - Khóa phiên tường minh (sao chép từ `openclaw sessions --json` hoặc [sessions CLI](/cli/sessions)).
  - Định dạng khóa phiên: xem [Sessions](/concepts/session) và [Groups](/channels/groups).
- `target`:
  - `last` (mặc định): gửi tới kênh bên ngoài được dùng gần nhất.
  - kênh tường minh: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: chạy heartbeat nhưng **không gửi** ra bên ngoài.
- `to`: ghi đè người nhận tùy chọn (id theo kênh, ví dụ E.164 cho WhatsApp hoặc chat id của Telegram).
- `accountId`: id tài khoản tùy chọn cho các kênh đa tài khoản. Khi `target: "last"`, id tài khoản áp dụng cho kênh cuối cùng được phân giải nếu kênh đó hỗ trợ tài khoản; nếu không thì bị bỏ qua. Nếu id tài khoản không khớp với tài khoản đã cấu hình cho kênh được phân giải, việc gửi sẽ bị bỏ qua.
- `prompt`: ghi đè nội dung prompt mặc định (không gộp).
- `ackMaxChars`: số ký tự tối đa cho phép sau `HEARTBEAT_OK` trước khi gửi.
- `activeHours`: giới hạn các lượt heartbeat trong một khung thời gian. Đối tượng với `start` (HH:MM, bao gồm), `end` (HH:MM không bao gồm; cho phép `24:00` cho cuối ngày), và tùy chọn `timezone`.
  - Bỏ qua hoặc `"user"`: dùng `agents.defaults.userTimezone` của bạn nếu đã đặt, nếu không thì dùng múi giờ của hệ thống máy chủ.
  - `"local"`: luôn dùng múi giờ hệ thống máy chủ.
  - Bất kỳ định danh IANA nào (ví dụ: `America/New_York`): dùng trực tiếp; nếu không hợp lệ, sẽ quay về hành vi `"user"` ở trên.
  - Ngoài khung giờ hoạt động, heartbeat sẽ bị bỏ qua cho đến nhịp tiếp theo trong khung giờ.

## Hành vi gửi

- Heartbeat chạy trong phiên chính của tác tử theo mặc định (`agent:<id>:<mainKey>`),
  hoặc `global` khi `session.scope = "global"`. Đặt `session` để ghi đè sang
  một phiên kênh cụ thể (Discord/WhatsApp/etc.).
- `session` chỉ ảnh hưởng đến ngữ cảnh chạy; việc gửi được điều khiển bởi `target` và `to`.
- Để gửi tới một kênh/người nhận cụ thể, đặt `target` + `to`. Với
  `target: "last"`, việc gửi dùng kênh bên ngoài gần nhất cho phiên đó.
- Nếu hàng đợi chính đang bận, heartbeat sẽ bị bỏ qua và thử lại sau.
- Nếu `target` không phân giải được đích bên ngoài, lượt chạy vẫn diễn ra nhưng không có
  thông điệp gửi ra.
- Các phản hồi chỉ dành cho heartbeat **không** giữ phiên hoạt động; `updatedAt`
  cuối cùng sẽ được khôi phục để việc hết hạn khi nhàn rỗi diễn ra bình thường.

## Kiểm soát hiển thị

Theo mặc định, các ack `HEARTBEAT_OK` bị ẩn trong khi nội dung cảnh báo
được gửi. Bạn có thể điều chỉnh theo từng kênh hoặc từng tài khoản:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Thứ tự ưu tiên: theo tài khoản → theo kênh → mặc định kênh → mặc định tích hợp.

### Ý nghĩa của từng cờ

- `showOk`: gửi một ack `HEARTBEAT_OK` khi mô hình trả về phản hồi chỉ-OK.
- `showAlerts`: gửi nội dung cảnh báo khi mô hình trả về phản hồi không-OK.
- `useIndicator`: phát các sự kiện chỉ báo cho các bề mặt trạng thái UI.

Nếu **cả ba** đều false, OpenClaw sẽ bỏ qua hoàn toàn lượt heartbeat (không gọi mô hình).

### Ví dụ theo kênh vs theo tài khoản

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Mẫu thường gặp

| Mục tiêu                                          | Cấu hình                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Hành vi mặc định (OK im lặng, có cảnh báo)        | _(không cần cấu hình)_                                                                   |
| Im lặng hoàn toàn (không tin nhắn, không chỉ báo) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Chỉ chỉ báo (không tin nhắn)                      | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OK chỉ ở một kênh                                 | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (tùy chọn)

Nếu một tệp `HEARTBEAT.md` tồn tại trong workspace, prompt mặc định sẽ yêu cầu
tác tử đọc nó. Hãy coi nó như “checklist heartbeat” của bạn: nhỏ gọn, ổn định và
an toàn để đưa vào mỗi 30 phút.

Nếu `HEARTBEAT.md` tồn tại nhưng về cơ bản là trống (chỉ có dòng trống và các header markdown
như `# Heading`), OpenClaw sẽ bỏ qua lượt heartbeat để tiết kiệm API calls.
Nếu tệp bị thiếu, heartbeat vẫn chạy và mô hình tự quyết định làm gì.

Giữ nó thật gọn (checklist hoặc nhắc việc ngắn) để tránh phình prompt.

Ví dụ `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Tác tử có thể cập nhật HEARTBEAT.md không?

Có — nếu bạn yêu cầu.

`HEARTBEAT.md` chỉ là một tệp bình thường trong workspace của tác tử, vì vậy bạn có thể nói với
tác tử (trong một cuộc trò chuyện bình thường) những câu như:

- “Cập nhật `HEARTBEAT.md` để thêm kiểm tra lịch hàng ngày.”
- “Viết lại `HEARTBEAT.md` để ngắn hơn và tập trung vào theo dõi hộp thư đến.”

Nếu bạn muốn điều này diễn ra chủ động, bạn cũng có thể thêm một dòng tường minh trong
prompt heartbeat như: “Nếu checklist trở nên lỗi thời, hãy cập nhật HEARTBEAT.md
bằng một checklist tốt hơn.”

Lưu ý an toàn: đừng đưa bí mật (khóa API, số điện thoại, token riêng tư) vào
`HEARTBEAT.md` — nó sẽ trở thành một phần của ngữ cảnh prompt.

## Đánh thức thủ công (theo yêu cầu)

Bạn có thể đưa một sự kiện hệ thống vào hàng đợi và kích hoạt một heartbeat ngay lập tức bằng:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Nếu nhiều tác tử có `heartbeat` được cấu hình, một lần đánh thức thủ công sẽ chạy ngay
heartbeat của từng tác tử đó.

Dùng `--mode next-heartbeat` để chờ nhịp đã lên lịch tiếp theo.

## Gửi reasoning (tùy chọn)

Theo mặc định, heartbeat chỉ gửi payload “câu trả lời” cuối cùng.

Nếu bạn muốn minh bạch, hãy bật:

- `agents.defaults.heartbeat.includeReasoning: true`

Khi bật, heartbeat cũng sẽ gửi một thông điệp riêng được tiền tố
`Reasoning:` (cùng dạng với `/reasoning on`). Điều này có thể hữu ích khi tác tử
đang quản lý nhiều phiên/codex và bạn muốn biết vì sao nó quyết định ping
bạn — nhưng cũng có thể làm lộ nhiều chi tiết nội bộ hơn bạn mong muốn. Nên
giữ tắt trong các cuộc trò chuyện nhóm.

## Nhận thức chi phí

Heartbeat chạy các lượt tác tử đầy đủ. Khoảng thời gian ngắn hơn sẽ tiêu tốn nhiều token hơn. Giữ
`HEARTBEAT.md` nhỏ và cân nhắc một `model` hoặc `target: "none"` rẻ hơn nếu bạn
chỉ muốn cập nhật trạng thái nội bộ.
