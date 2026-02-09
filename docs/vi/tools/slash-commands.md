---
summary: "Lệnh slash: văn bản so với native, cấu hình và các lệnh được hỗ trợ"
read_when:
  - Sử dụng hoặc cấu hình lệnh chat
  - Gỡ lỗi định tuyến lệnh hoặc quyền
title: "Lệnh Slash"
---

# Lệnh slash

8. Các lệnh được xử lý bởi Gateway. 9. Hầu hết các lệnh phải được gửi dưới dạng một tin nhắn **độc lập** bắt đầu bằng `/`.
9. Lệnh chat bash chỉ dành cho host sử dụng `!`. 11. `<cmd>` (với `/bash <cmd>` là bí danh).

Có hai hệ thống liên quan:

- **Commands**: các tin nhắn `/...` độc lập.
- **Directives**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Directives sẽ bị loại khỏi tin nhắn trước khi mô hình nhìn thấy.
  - Trong tin nhắn chat thông thường (không chỉ gồm directive), chúng được xem là “gợi ý nội tuyến” và **không** lưu trạng thái phiên.
  - Trong tin nhắn chỉ có directive (tin nhắn chỉ chứa directive), chúng được lưu vào phiên và trả về xác nhận.
  - Directives are only applied for **authorized senders** (channel allowlists/pairing plus `commands.useAccessGroups`).
    12. Người gửi không được ủy quyền sẽ thấy các directive được xử lý như văn bản thuần.

13. Cũng có một vài **phím tắt nội tuyến** (chỉ dành cho người gửi trong allowlist/được ủy quyền): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
    They run immediately, are stripped before the model sees the message, and the remaining text continues through the normal flow.

## Cấu hình

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (mặc định `true`) bật phân tích `/...` trong tin nhắn chat.
  - Trên các nền tảng không có lệnh native (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), lệnh văn bản vẫn hoạt động ngay cả khi bạn đặt giá trị này thành `false`.
- `commands.native` (mặc định `"auto"`) đăng ký các lệnh native.
  - Tự động: bật cho Discord/Telegram; tắt cho Slack (cho đến khi bạn thêm lệnh slash); bị bỏ qua với nhà cung cấp không hỗ trợ native.
  - Đặt `channels.discord.commands.native`, `channels.telegram.commands.native` hoặc `channels.slack.commands.native` để ghi đè theo từng nhà cung cấp (bool hoặc `"auto"`).
  - 14. `false` sẽ xóa các lệnh đã đăng ký trước đó trên Discord/Telegram khi khởi động. 15. Các lệnh Slack được quản lý trong ứng dụng Slack và không bị xóa tự động.
- `commands.nativeSkills` (mặc định `"auto"`) đăng ký các lệnh **skill** ở dạng native khi được hỗ trợ.
  - Tự động: bật cho Discord/Telegram; tắt cho Slack (Slack yêu cầu tạo một lệnh slash cho mỗi skill).
  - Đặt `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` hoặc `channels.slack.commands.nativeSkills` để ghi đè theo từng nhà cung cấp (bool hoặc `"auto"`).
- 24. `commands.bash` (mặc định `false`) bật `! <cmd>` to run host shell commands (`/bash <cmd>` is an alias; requires `tools.elevated` allowlists).
- `commands.bashForegroundMs` (mặc định `2000`) kiểm soát thời gian bash chờ trước khi chuyển sang chế độ nền (`0` chạy nền ngay).
- `commands.config` (mặc định `false`) bật `/config` (đọc/ghi `openclaw.json`).
- `commands.debug` (mặc định `false`) bật `/debug` (ghi đè chỉ trong runtime).
- `commands.useAccessGroups` (mặc định `true`) thực thi danh sách cho phép/chính sách cho lệnh.

## Danh sách lệnh

Văn bản + native (khi được bật):

- `/help`
- `/commands`
- `/skill <name> [input]` (chạy một skill theo tên)
- `/status` (hiển thị trạng thái hiện tại; bao gồm mức sử dụng/hạn mức của nhà cung cấp cho nhà cung cấp mô hình hiện tại khi có)
- `/allowlist` (liệt kê/thêm/xóa mục trong danh sách cho phép)
- `/approve <id> allow-once|allow-always|deny` (giải quyết các lời nhắc phê duyệt exec)
- `/context [list|detail|json]` (giải thích “context”; `detail` hiển thị kích thước theo từng tệp + từng công cụ + từng skill + system prompt)
- `/whoami` (hiển thị sender id của bạn; bí danh: `/id`)
- `/subagents list|stop|log|info|send` (kiểm tra, dừng, xem log hoặc nhắn tin các lần chạy sub-agent cho phiên hiện tại)
- `/config show|get|set|unset` (ghi cấu hình xuống đĩa, chỉ chủ sở hữu; yêu cầu `commands.config: true`)
- `/debug show|set|unset|reset` (ghi đè runtime, chỉ chủ sở hữu; yêu cầu `commands.debug: true`)
- `/usage off|tokens|full|cost` (chân trang mức sử dụng theo phản hồi hoặc tóm tắt chi phí cục bộ)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (điều khiển TTS; xem [/tts](/tts))
  - Discord: lệnh native là `/voice` (Discord giữ chỗ `/tts`); lệnh văn bản `/tts` vẫn hoạt động.
- `/stop`
- `/restart`
- `/dock-telegram` (bí danh: `/dock_telegram`) (chuyển phản hồi sang Telegram)
- `/dock-discord` (bí danh: `/dock_discord`) (chuyển phản hồi sang Discord)
- `/dock-slack` (bí danh: `/dock_slack`) (chuyển phản hồi sang Slack)
- `/activation mention|always` (chỉ nhóm)
- `/send on|off|inherit` (chỉ chủ sở hữu)
- `/reset` hoặc `/new [model]` (gợi ý mô hình tùy chọn; phần còn lại được chuyển tiếp)
- `/think <off|minimal|low|medium|high|xhigh>` (lựa chọn động theo mô hình/nhà cung cấp; bí danh: `/thinking`, `/t`)
- `/verbose on|full|off` (bí danh: `/v`)
- `/reasoning on|off|stream` (bí danh: `/reason`; khi bật, gửi một tin nhắn riêng có tiền tố `Reasoning:`; `stream` = chỉ bản nháp Telegram)
- `/elevated on|off|ask|full` (bí danh: `/elev`; `full` bỏ qua phê duyệt exec)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (gửi `/exec` để hiển thị hiện tại)
- `/model <name>` (bí danh: `/models`; hoặc `/<alias>` từ `agents.defaults.models.*.alias`)
- `/queue <mode>` (kèm các tùy chọn như `debounce:2s cap:25 drop:summarize`; gửi `/queue` để xem cài đặt hiện tại)
- `/bash <command>` (host-only; alias for `! <command>`; requires `commands.bash: true` + `tools.elevated` allowlists)

Chỉ văn bản:

- `/compact [instructions]` (xem [/concepts/compaction](/concepts/compaction))
- `! 25. <command>` (chỉ cho host; từng lệnh một; dùng `!poll` + `!stop` cho các tác vụ chạy lâu)
- `!poll` (kiểm tra đầu ra / trạng thái; chấp nhận tùy chọn `sessionId`; `/bash poll` cũng hoạt động)
- `!stop` (dừng tác vụ bash đang chạy; chấp nhận tùy chọn `sessionId`; `/bash stop` cũng hoạt động)

Ghi chú:

- Lệnh chấp nhận một `:` tùy chọn giữa lệnh và đối số (ví dụ: `/think: high`, `/send: on`, `/help:`).
- `/new <model>` chấp nhận bí danh mô hình, `provider/model`, hoặc tên nhà cung cấp (khớp mờ); nếu không khớp, văn bản sẽ được coi là nội dung tin nhắn.
- Để xem phân tích đầy đủ mức sử dụng theo nhà cung cấp, dùng `openclaw status --usage`.
- `/allowlist add|remove` yêu cầu `commands.config=true` và tuân theo `configWrites` của kênh.
- `/usage` kiểm soát chân trang mức sử dụng theo phản hồi; `/usage cost` in tóm tắt chi phí cục bộ từ log phiên OpenClaw.
- `/restart` bị tắt theo mặc định; đặt `commands.restart: true` để bật.
- `/verbose` предназнач cho gỡ lỗi và tăng khả năng quan sát; hãy giữ **tắt** trong sử dụng bình thường.
- `/reasoning` (and `/verbose`) are risky in group settings: they may reveal internal reasoning or tool output you did not intend to expose. Prefer leaving them off, especially in group chats.
- **Đường nhanh:** tin nhắn chỉ có lệnh từ người gửi trong danh sách cho phép được xử lý ngay (bỏ qua hàng đợi + mô hình).
- **Chặn theo đề cập nhóm:** tin nhắn chỉ có lệnh từ người gửi trong danh sách cho phép bỏ qua yêu cầu đề cập.
- **Phím tắt nội tuyến (chỉ cho người gửi trong danh sách cho phép):** một số lệnh cũng hoạt động khi nhúng trong tin nhắn thường và bị loại bỏ trước khi mô hình thấy phần văn bản còn lại.
  - Ví dụ: `hey /status` kích hoạt phản hồi trạng thái, và phần văn bản còn lại tiếp tục theo luồng bình thường.
- Hiện tại: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Tin nhắn chỉ có lệnh từ người không được ủy quyền sẽ bị bỏ qua âm thầm, và các token `/...` nội tuyến được xử lý như văn bản thường.
- 17. **Lệnh kỹ năng:** các kỹ năng `user-invocable` được hiển thị dưới dạng lệnh slash. 18. Tên được làm sạch thành `a-z0-9_` (tối đa 32 ký tự); trùng lặp sẽ được thêm hậu tố số (ví dụ: `_2`).
  - `/skill <name> [input]` chạy một skill theo tên (hữu ích khi giới hạn lệnh native ngăn tạo lệnh theo từng skill).
  - Theo mặc định, lệnh skill được chuyển tới mô hình như một yêu cầu bình thường.
  - Skill có thể tùy chọn khai báo `command-dispatch: tool` để định tuyến lệnh trực tiếp tới một công cụ (xác định, không qua mô hình).
  - Ví dụ: `/prose` (plugin OpenProse) — xem [OpenProse](/prose).
- 19. **Đối số lệnh gốc:** Discord sử dụng tự động hoàn thành cho các tùy chọn động (và menu nút khi bạn bỏ qua các đối số bắt buộc). Telegram and Slack show a button menu when a command supports choices and you omit the arg.

## Bề mặt sử dụng (hiển thị ở đâu)

- **Mức sử dụng/hạn mức theo nhà cung cấp** (ví dụ: “Claude còn 80%”) hiển thị trong `/status` cho nhà cung cấp mô hình hiện tại khi bật theo dõi mức sử dụng.
- **Token/chi phí theo phản hồi** được kiểm soát bởi `/usage off|tokens|full` (đính kèm vào phản hồi thường).
- `/model status` nói về **mô hình/xác thực/endpoint**, không phải mức sử dụng.

## Chọn mô hình (`/model`)

`/model` được triển khai dưới dạng directive.

Ví dụ:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Ghi chú:

- `/model` và `/model list` hiển thị bộ chọn gọn, có đánh số (họ mô hình + các nhà cung cấp khả dụng).
- `/model <#>` chọn từ bộ chọn đó (và ưu tiên nhà cung cấp hiện tại khi có thể).
- `/model status` hiển thị chế độ xem chi tiết, bao gồm endpoint nhà cung cấp đã cấu hình (`baseUrl`) và chế độ API (`api`) khi có.

## Ghi đè gỡ lỗi

`/debug` lets you set **runtime-only** config overrides (memory, not disk). 30. Chỉ dành cho owner. 20. Mặc định bị tắt; bật bằng `commands.debug: true`.

Ví dụ:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Ghi chú:

- Ghi đè áp dụng ngay cho các lần đọc cấu hình mới, nhưng **không** ghi vào `openclaw.json`.
- Dùng `/debug reset` để xóa tất cả ghi đè và quay về cấu hình trên đĩa.

## Cập nhật cấu hình

`/config` writes to your on-disk config (`openclaw.json`). 32. Chỉ dành cho owner. 21. Mặc định bị tắt; bật bằng `commands.config: true`.

Ví dụ:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Ghi chú:

- Cấu hình được kiểm tra hợp lệ trước khi ghi; thay đổi không hợp lệ sẽ bị từ chối.
- Các cập nhật `/config` tồn tại qua các lần khởi động lại.

## Ghi chú theo bề mặt

- **Lệnh văn bản** chạy trong phiên chat bình thường (DM chia sẻ `main`, nhóm có phiên riêng).
- **Lệnh native** dùng các phiên cô lập:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (tiền tố có thể cấu hình qua `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (nhắm vào phiên chat qua `CommandTargetSessionKey`)
- **`/stop`** nhắm vào phiên chat đang hoạt động để có thể hủy lần chạy hiện tại.
- **Slack:** `channels.slack.slashCommand` is still supported for a single `/openclaw`-style command. If you enable `commands.native`, you must create one Slack slash command per built-in command (same names as `/help`). Command argument menus for Slack are delivered as ephemeral Block Kit buttons.
