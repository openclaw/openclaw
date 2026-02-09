---
summary: "Sổ tay xử lý sự cố chuyên sâu cho gateway, kênh, tự động hóa, node và trình duyệt"
read_when:
  - Trung tâm xử lý sự cố đã điều hướng bạn tới đây để chẩn đoán sâu hơn
  - Bạn cần các mục sổ tay dựa trên triệu chứng ổn định với lệnh chính xác
title: "Xử lý sự cố"
---

# Xử lý sự cố Gateway

This page is the deep runbook.
Start at [/help/troubleshooting](/help/troubleshooting) if you want the fast triage flow first.

## Thang lệnh

Chạy các lệnh sau trước, theo đúng thứ tự:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Các tín hiệu khỏe mạnh mong đợi:

- `openclaw gateway status` hiển thị `Runtime: running` và `RPC probe: ok`.
- `openclaw doctor` báo cáo không có vấn đề cấu hình/dịch vụ gây chặn.
- `openclaw channels status --probe` hiển thị các kênh đã kết nối/sẵn sàng.

## Không có phản hồi

Nếu các kênh đang hoạt động nhưng không có gì trả lời, hãy kiểm tra định tuyến và chính sách trước khi kết nối lại bất kỳ thứ gì.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Cần kiểm tra:

- Ghép cặp đang chờ đối với người gửi DM.
- Kiểm soát đề cập trong nhóm (`requireMention`, `mentionPatterns`).
- Không khớp danh sách cho phép kênh/nhóm.

Dấu hiệu thường gặp:

- `drop guild message (mention required` → tin nhắn nhóm bị bỏ qua cho đến khi có đề cập.
- `pairing request` → người gửi cần được phê duyệt.
- `blocked` / `allowlist` → người gửi/kênh bị lọc bởi chính sách.

Liên quan:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Kết nối UI điều khiển bảng điều khiển

Khi UI bảng điều khiển/điều khiển không kết nối được, hãy xác thực URL, chế độ xác thực và các giả định về ngữ cảnh bảo mật.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Cần kiểm tra:

- URL thăm dò và URL bảng điều khiển chính xác.
- Không khớp chế độ xác thực/token giữa client và gateway.
- Sử dụng HTTP trong khi yêu cầu định danh thiết bị.

Dấu hiệu thường gặp:

- `device identity required` → ngữ cảnh không bảo mật hoặc thiếu xác thực thiết bị.
- `unauthorized` / vòng lặp kết nối lại → không khớp token/mật khẩu.
- `gateway connect failed:` → sai đích host/cổng/url.

Liên quan:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Dịch vụ Gateway không chạy

Dùng mục này khi dịch vụ đã được cài đặt nhưng tiến trình không duy trì hoạt động.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Cần kiểm tra:

- `Runtime: stopped` với gợi ý thoát.
- Không khớp cấu hình dịch vụ (`Config (cli)` so với `Config (service)`).
- Xung đột cổng/trình lắng nghe.

Dấu hiệu thường gặp:

- `Gateway start blocked: set gateway.mode=local` → chế độ gateway cục bộ chưa được bật.
- `refusing to bind gateway ... without auth` → non-loopback bind without token/password.
- `another gateway instance is already listening` / `EADDRINUSE` → xung đột cổng.

Liên quan:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Kênh đã kết nối nhưng tin nhắn không luân chuyển

Nếu trạng thái kênh là đã kết nối nhưng luồng tin nhắn bị tắc, hãy tập trung vào chính sách, quyền và các quy tắc phân phối theo từng kênh.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Cần kiểm tra:

- Chính sách DM (`pairing`, `allowlist`, `open`, `disabled`).
- Danh sách cho phép nhóm và yêu cầu đề cập.
- Thiếu quyền/phạm vi API của kênh.

Dấu hiệu thường gặp:

- `mention required` → tin nhắn bị bỏ qua bởi chính sách đề cập nhóm.
- `pairing` / dấu vết chờ phê duyệt → người gửi chưa được phê duyệt.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → sự cố xác thực/quyền của kênh.

Liên quan:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Phân phối cron và heartbeat

Nếu cron hoặc heartbeat không chạy hoặc không phân phối được, hãy xác minh trạng thái bộ lập lịch trước, sau đó là đích phân phối.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Cần kiểm tra:

- Cron được bật và có lần đánh thức tiếp theo.
- Trạng thái lịch sử chạy job (`ok`, `skipped`, `error`).
- Lý do bỏ qua heartbeat (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Dấu hiệu thường gặp:

- `cron: scheduler disabled; jobs will not run automatically` → cron bị tắt.
- `cron: timer tick failed` → nhịp lập lịch thất bại; kiểm tra lỗi file/log/runtime.
- `heartbeat skipped` với `reason=quiet-hours` → nằm ngoài khung giờ hoạt động.
- `heartbeat: unknown accountId` → id tài khoản không hợp lệ cho đích phân phối heartbeat.

Liên quan:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Công cụ node đã ghép cặp nhưng thất bại

Nếu node đã được ghép cặp nhưng công cụ không hoạt động, hãy cô lập trạng thái tiền cảnh, quyền và phê duyệt.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Cần kiểm tra:

- Node trực tuyến với các khả năng mong đợi.
- Quyền hệ điều hành cho camera/mic/vị trí/màn hình.
- Phê duyệt exec và trạng thái danh sách cho phép.

Dấu hiệu thường gặp:

- `NODE_BACKGROUND_UNAVAILABLE` → ứng dụng node phải ở tiền cảnh.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → thiếu quyền hệ điều hành.
- `SYSTEM_RUN_DENIED: approval required` → phê duyệt exec đang chờ.
- `SYSTEM_RUN_DENIED: allowlist miss` → lệnh bị chặn bởi danh sách cho phép.

Liên quan:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Công cụ trình duyệt thất bại

Dùng mục này khi các hành động của công cụ trình duyệt thất bại dù gateway vẫn khỏe mạnh.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Cần kiểm tra:

- Đường dẫn thực thi trình duyệt hợp lệ.
- Khả năng truy cập hồ sơ CDP.
- Gắn tab relay của tiện ích mở rộng cho `profile="chrome"`.

Dấu hiệu thường gặp:

- `Failed to start Chrome CDP on port` → tiến trình trình duyệt không khởi chạy được.
- `browser.executablePath not found` → đường dẫn cấu hình không hợp lệ.
- `Chrome extension relay is running, but no tab is connected` → relay của tiện ích chưa được gắn.
- `Browser attachOnly is enabled ... not reachable` → attach-only profile has no reachable target.

Liên quan:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Nếu bạn nâng cấp và đột nhiên có thứ gì đó hỏng

Hầu hết sự cố sau nâng cấp là do lệch cấu hình hoặc các mặc định chặt chẽ hơn hiện đang được áp dụng.

### 1. Hành vi ghi đè xác thực và URL đã thay đổi

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Cần kiểm tra:

- Nếu `gateway.mode=remote`, các lệnh CLI có thể đang nhắm tới remote trong khi dịch vụ cục bộ của bạn vẫn ổn.
- Các lệnh `--url` tường minh không tự động quay về thông tin xác thực đã lưu.

Dấu hiệu thường gặp:

- `gateway connect failed:` → sai đích URL.
- `unauthorized` → endpoint truy cập được nhưng xác thực sai.

### 2. Ràng buộc bind và xác thực chặt chẽ hơn

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Cần kiểm tra:

- Bind không phải loopback (`lan`, `tailnet`, `custom`) cần cấu hình xác thực.
- Các khóa cũ như `gateway.token` không thay thế cho `gateway.auth.token`.

Dấu hiệu thường gặp:

- `refusing to bind gateway ... without auth` → bind+auth mismatch.
- `RPC probe: failed` trong khi runtime đang chạy → gateway còn sống nhưng không truy cập được với xác thực/url hiện tại.

### 3. Trạng thái ghép cặp và định danh thiết bị đã thay đổi

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Cần kiểm tra:

- Phê duyệt thiết bị đang chờ cho bảng điều khiển/node.
- Phê duyệt ghép cặp DM đang chờ sau khi thay đổi chính sách hoặc định danh.

Dấu hiệu thường gặp:

- `device identity required` → xác thực thiết bị chưa được thỏa mãn.
- `pairing required` → người gửi/thiết bị cần được phê duyệt.

Nếu cấu hình dịch vụ và runtime vẫn không khớp sau khi kiểm tra, hãy cài đặt lại metadata dịch vụ từ cùng thư mục hồ sơ/trạng thái:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Liên quan:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
