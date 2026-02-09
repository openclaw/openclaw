---
summary: "Cron jobs + cơ chế đánh thức cho bộ lập lịch Gateway"
read_when:
  - Lập lịch các tác vụ nền hoặc wakeup
  - Kết nối tự động hóa cần chạy cùng hoặc song song với heartbeat
  - Quyết định giữa heartbeat và cron cho các tác vụ theo lịch
title: "Cron Jobs"
---

# Cron jobs (bộ lập lịch Gateway)

> **Cron hay Heartbeat?** Xem [Cron vs Heartbeat](/automation/cron-vs-heartbeat) để được hướng dẫn khi nào nên dùng từng loại.

Cron là bộ lập lịch tích hợp sẵn của Gateway. Nó lưu trữ các job, đánh thức agent vào đúng thời điểm và có thể tùy chọn gửi đầu ra trở lại một cuộc trò chuyện.

Nếu bạn muốn _“chạy việc này mỗi sáng”_ hoặc _“nhắc tác tử sau 20 phút”_,
thì cron là cơ chế phù hợp.

Xử lý sự cố: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron chạy **bên trong Gateway** (không chạy trong mô hình).
- Job được lưu bền vững dưới `~/.openclaw/cron/` nên việc khởi động lại không làm mất lịch.
- Hai kiểu thực thi:
  - **Phiên chính**: xếp hàng một system event, sau đó chạy ở heartbeat tiếp theo.
  - **Cô lập**: chạy một lượt tác tử riêng trong `cron:<jobId>`, kèm cơ chế gửi kết quả (mặc định là announce hoặc không gửi).
- Wakeup là hạng nhất: job có thể yêu cầu “đánh thức ngay” thay vì “heartbeat tiếp theo”.

## Khởi động nhanh (có thể hành động ngay)

Tạo một lời nhắc một lần, xác minh nó tồn tại và chạy ngay lập tức:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Lên lịch một job cô lập định kỳ có gửi kết quả:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Tương đương tool-call (Gateway cron tool)

Để xem các dạng JSON chuẩn và ví dụ, xem [JSON schema cho tool calls](/automation/cron-jobs#json-schema-for-tool-calls).

## Nơi cron jobs được lưu trữ

Các cron job được lưu trữ trên máy chủ Gateway tại `~/.openclaw/cron/jobs.json` theo mặc định.
Gateway tải tệp này vào bộ nhớ và ghi lại khi có thay đổi, vì vậy việc chỉnh sửa thủ công
chỉ an toàn khi Gateway đã dừng. Ưu tiên dùng `openclaw cron add/edit` hoặc API gọi công cụ cron để thực hiện thay đổi.

## Tổng quan thân thiện cho người mới

Hãy nghĩ cron job là: **khi nào** chạy + **chạy cái gì**.

1. **Chọn lịch**
   - Nhắc một lần → `schedule.kind = "at"` (CLI: `--at`)
   - Job lặp lại → `schedule.kind = "every"` hoặc `schedule.kind = "cron"`
   - Nếu timestamp ISO của bạn không có múi giờ, nó sẽ được coi là **UTC**.

2. **Chọn nơi chạy**
   - `sessionTarget: "main"` → chạy trong heartbeat tiếp theo với ngữ cảnh phiên chính.
   - `sessionTarget: "isolated"` → chạy một lượt tác tử riêng trong `cron:<jobId>`.

3. **Chọn payload**
   - Phiên chính → `payload.kind = "systemEvent"`
   - Phiên cô lập → `payload.kind = "agentTurn"`

Tùy chọn: các job chạy một lần (`schedule.kind = "at"`) sẽ tự xóa sau khi chạy thành công theo mặc định. Đặt
`deleteAfterRun: false` để giữ chúng (chúng sẽ bị vô hiệu hóa sau khi chạy thành công).

## Khái niệm

### Jobs

Một cron job là một bản ghi được lưu với:

- một **lịch** (khi nào chạy),
- một **payload** (chạy gì),
- **chế độ gửi kết quả** tùy chọn (announce hoặc none).
- **ràng buộc tác tử** tùy chọn (`agentId`): chạy job dưới một tác tử cụ thể; nếu
  thiếu hoặc không xác định, gateway sẽ dùng tác tử mặc định.

Các job được định danh bằng một `jobId` ổn định (được dùng bởi CLI/API Gateway).
Trong các lời gọi công cụ của agent, `jobId` là chuẩn; `id` cũ vẫn được chấp nhận để tương thích.
Các job chạy một lần tự xóa sau khi thành công theo mặc định; đặt `deleteAfterRun: false` để giữ lại chúng.

### Lịch

Cron hỗ trợ ba loại lịch:

- `at`: timestamp một lần qua `schedule.at` (ISO 8601).
- `every`: khoảng thời gian cố định (ms).
- `cron`: biểu thức cron 5 trường với múi giờ IANA tùy chọn.

Biểu thức cron sử dụng `croner`. Nếu không chỉ định múi giờ, múi giờ cục bộ của máy chủ Gateway sẽ được sử dụng.

### Thực thi phiên chính vs cô lập

#### Job phiên chính (system events)

Các job chính xếp hàng một sự kiện hệ thống và có thể tùy chọn đánh thức trình chạy heartbeat.
Chúng phải dùng `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (mặc định): sự kiện kích hoạt một heartbeat ngay lập tức.
- `wakeMode: "next-heartbeat"`: sự kiện chờ đến heartbeat theo lịch tiếp theo.

Đây là lựa chọn phù hợp nhất khi bạn muốn lời nhắc heartbeat thông thường + ngữ cảnh phiên chính.
Xem [Heartbeat](/gateway/heartbeat).

#### Job cô lập (phiên cron riêng)

Job cô lập chạy một lượt tác tử riêng trong phiên `cron:<jobId>`.

Hành vi chính:

- Prompt được tiền tố `[cron:<jobId> <job name>]` để dễ truy vết.
- Mỗi lần chạy bắt đầu với **session id mới** (không mang theo hội thoại trước).
- Hành vi mặc định: nếu `delivery` bị bỏ qua, job cô lập sẽ announce một bản tóm tắt (`delivery.mode = "announce"`).
- `delivery.mode` (chỉ cho cô lập) quyết định điều gì xảy ra:
  - `announce`: gửi bản tóm tắt tới kênh đích và đăng một bản tóm tắt ngắn vào phiên chính.
  - `none`: chỉ nội bộ (không gửi, không có tóm tắt phiên chính).
- `wakeMode` kiểm soát thời điểm đăng tóm tắt phiên chính:
  - `now`: heartbeat ngay lập tức.
  - `next-heartbeat`: chờ heartbeat theo lịch tiếp theo.

Hãy dùng job cô lập cho các tác vụ ồn ào, tần suất cao hoặc “việc nền”
không nên làm spam lịch sử chat chính.

### Dạng payload (chạy gì)

Hỗ trợ hai loại payload:

- `systemEvent`: chỉ phiên chính, được định tuyến qua prompt heartbeat.
- `agentTurn`: chỉ phiên cô lập, chạy một lượt tác tử riêng.

Các trường `agentTurn` chung:

- `message`: prompt văn bản bắt buộc.
- `model` / `thinking`: ghi đè tùy chọn (xem bên dưới).
- `timeoutSeconds`: ghi đè timeout tùy chọn.

Cấu hình gửi kết quả (chỉ job cô lập):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` hoặc một kênh cụ thể.
- `delivery.to`: đích cụ thể theo kênh (phone/chat/channel id).
- `delivery.bestEffort`: tránh làm job thất bại nếu gửi announce thất bại.

Chế độ Announce delivery sẽ chặn việc gửi qua công cụ nhắn tin cho lần chạy đó; dùng `delivery.channel`/`delivery.to` để nhắm tới cuộc trò chuyện thay thế. Khi `delivery.mode = "none"`, sẽ không có bản tóm tắt nào được đăng vào phiên chính.

Nếu `delivery` bị bỏ qua cho job cô lập, OpenClaw mặc định dùng `announce`.

#### Luồng announce delivery

Khi `delivery.mode = "announce"`, cron sẽ gửi trực tiếp thông qua các bộ chuyển kênh outbound.
Agent chính sẽ không được khởi chạy để soạn hoặc chuyển tiếp thông điệp.

Chi tiết hành vi:

- Nội dung: việc gửi dùng payload outbound (text/media) của lượt chạy cô lập với phân mảnh và
  định dạng kênh bình thường.
- Phản hồi chỉ-heartbeat (`HEARTBEAT_OK` không có nội dung thực) sẽ không được gửi.
- Nếu lượt chạy cô lập đã gửi tin nhắn tới cùng đích bằng message tool, việc gửi sẽ bị bỏ qua để tránh trùng lặp.
- Đích gửi thiếu hoặc không hợp lệ sẽ làm job thất bại trừ khi `delivery.bestEffort = true`.
- Một bản tóm tắt ngắn chỉ được đăng vào phiên chính khi `delivery.mode = "announce"`.
- Tóm tắt phiên chính tuân theo `wakeMode`: `now` kích hoạt heartbeat ngay và
  `next-heartbeat` chờ heartbeat theo lịch tiếp theo.

### Ghi đè mô hình và mức thinking

Job cô lập (`agentTurn`) có thể ghi đè mô hình và mức thinking:

- `model`: chuỗi provider/mô hình (ví dụ `anthropic/claude-sonnet-4-20250514`) hoặc alias (ví dụ `opus`)
- `thinking`: mức thinking (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; chỉ cho GPT-5.2 + Codex)

1. Lưu ý: Bạn cũng có thể đặt `model` cho các job main-session, nhưng điều này sẽ thay đổi model của main session dùng chung. Chúng tôi khuyến nghị chỉ ghi đè model cho các job cô lập để tránh những thay đổi ngữ cảnh không mong muốn.

Thứ tự ưu tiên phân giải:

1. Ghi đè trong payload của job (cao nhất)
2. Mặc định theo hook (ví dụ `hooks.gmail.model`)
3. Mặc định trong cấu hình tác tử

### Gửi kết quả (kênh + đích)

Job cô lập có thể gửi đầu ra tới một kênh qua cấu hình top-level `delivery`:

- `delivery.mode`: `announce` (gửi bản tóm tắt) hoặc `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to`: đích người nhận theo kênh.

Cấu hình gửi chỉ hợp lệ cho job cô lập (`sessionTarget: "isolated"`).

Nếu `delivery.channel` hoặc `delivery.to` bị bỏ qua, cron có thể quay về “last route”
của phiên chính (nơi cuối cùng tác tử đã trả lời).

Nhắc định dạng đích:

- Đích Slack/Discord/Mattermost (plugin) nên dùng tiền tố rõ ràng (ví dụ `channel:<id>`, `user:<id>`) để tránh mơ hồ.
- Topic Telegram nên dùng dạng `:topic:` (xem bên dưới).

#### Đích gửi Telegram (topics / forum threads)

Telegram hỗ trợ các chủ đề diễn đàn thông qua `message_thread_id`. Đối với việc gửi qua cron, bạn có thể mã hóa chủ đề/thread vào trường `to`:

- `-1001234567890` (chỉ chat id)
- `-1001234567890:topic:123` (khuyến nghị: marker topic tường minh)
- `-1001234567890:123` (viết tắt: hậu tố số)

Các đích có tiền tố như `telegram:...` / `telegram:group:...` cũng được chấp nhận:

- `telegram:group:-1001234567890:topic:123`

## JSON schema cho tool calls

Hãy dùng các dạng này khi gọi trực tiếp các công cụ Gateway `cron.*` (lời gọi công cụ agent hoặc RPC).
Các cờ CLI chấp nhận khoảng thời gian dạng con người như `20m`, nhưng các lời gọi công cụ nên dùng chuỗi ISO 8601 cho `schedule.at` và mili giây cho `schedule.everyMs`.

### Tham số cron.add

Job một lần, phiên chính (system event):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

Job định kỳ, cô lập có gửi kết quả:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Ghi chú:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), hoặc `cron` (`expr`, `tz` tùy chọn).
- `schedule.at` chấp nhận ISO 8601 (múi giờ tùy chọn; nếu bỏ qua sẽ coi là UTC).
- `everyMs` là mili-giây.
- `sessionTarget` phải là `"main"` hoặc `"isolated"` và phải khớp với `payload.kind`.
- Trường tùy chọn: `agentId`, `description`, `enabled`, `deleteAfterRun` (mặc định true cho `at`),
  `delivery`.
- `wakeMode` mặc định là `"now"` khi bị bỏ qua.

### Tham số cron.update

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Ghi chú:

- `jobId` là chuẩn; `id` được chấp nhận để tương thích.
- Dùng `agentId: null` trong patch để xóa ràng buộc tác tử.

### Tham số cron.run và cron.remove

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Lưu trữ & lịch sử

- Kho job: `~/.openclaw/cron/jobs.json` (JSON do Gateway quản lý).
- Lịch sử chạy: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, tự dọn dẹp).
- Ghi đè đường dẫn lưu trữ: `cron.store` trong cấu hình.

## Cấu hình

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Vô hiệu hóa cron hoàn toàn:

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## CLI khởi động nhanh

Nhắc một lần (ISO UTC, tự xóa sau khi thành công):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Nhắc một lần (phiên chính, đánh thức ngay):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Job cô lập định kỳ (announce tới WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Job cô lập định kỳ (gửi tới một topic Telegram):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Job cô lập với ghi đè mô hình và thinking:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Chọn tác tử (thiết lập nhiều tác tử):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Chạy thủ công (force là mặc định, dùng `--due` để chỉ chạy khi đến hạn):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Chỉnh sửa một job hiện có (patch các trường):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Lịch sử chạy:

```bash
openclaw cron runs --id <jobId> --limit 50
```

System event ngay lập tức mà không tạo job:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Bề mặt API Gateway

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force hoặc due), `cron.runs`
  Với system event tức thì không có job, dùng [`openclaw system event`](/cli/system).

## Xử lý sự cố

### “Không có gì chạy”

- Kiểm tra cron đã bật chưa: `cron.enabled` và `OPENCLAW_SKIP_CRON`.
- Kiểm tra Gateway đang chạy liên tục (cron chạy bên trong tiến trình Gateway).
- Với lịch `cron`: xác nhận múi giờ (`--tz`) so với múi giờ máy chủ.

### Một job định kỳ liên tục bị trì hoãn sau khi lỗi

- OpenClaw áp dụng backoff retry theo hàm mũ cho job định kỳ sau các lỗi liên tiếp:
  30s, 1m, 5m, 15m, rồi 60m giữa các lần thử lại.
- Backoff tự reset sau lần chạy thành công tiếp theo.
- Job một lần (`at`) sẽ bị vô hiệu hóa sau một lần chạy kết thúc (`ok`, `error`, hoặc `skipped`) và không thử lại.

### Telegram gửi nhầm chỗ

- Với forum topics, hãy dùng `-100…:topic:<id>` để rõ ràng và không mơ hồ.
- Nếu bạn thấy tiền tố `telegram:...` trong log hoặc trong đích “last route” đã lưu, đó là bình thường;
  cron delivery chấp nhận chúng và vẫn phân tích đúng topic ID.
