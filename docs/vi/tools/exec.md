---
summary: "Cách dùng công cụ Exec, các chế độ stdin và hỗ trợ TTY"
read_when:
  - Khi dùng hoặc chỉnh sửa công cụ exec
  - Khi gỡ lỗi hành vi stdin hoặc TTY
title: "Công cụ Exec"
x-i18n:
  source_path: tools/exec.md
  source_hash: 3b32238dd8dce93d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:37Z
---

# Công cụ Exec

Chạy lệnh shell trong workspace. Hỗ trợ thực thi tiền cảnh + nền thông qua `process`.
Nếu `process` bị cấm, `exec` chạy đồng bộ và bỏ qua `yieldMs`/`background`.
Các phiên chạy nền được phạm vi theo từng tác tử; `process` chỉ thấy các phiên từ cùng tác tử.

## Tham số

- `command` (bắt buộc)
- `workdir` (mặc định là cwd)
- `env` (ghi đè key/value)
- `yieldMs` (mặc định 10000): tự động chuyển nền sau độ trễ
- `background` (bool): chuyển nền ngay lập tức
- `timeout` (giây, mặc định 1800): kết thúc khi hết hạn
- `pty` (bool): chạy trong pseudo-terminal khi có (CLI chỉ TTY, tác tử viết mã, UI terminal)
- `host` (`sandbox | gateway | node`): nơi thực thi
- `security` (`deny | allowlist | full`): chế độ thực thi cho `gateway`/`node`
- `ask` (`off | on-miss | always`): lời nhắc phê duyệt cho `gateway`/`node`
- `node` (string): id/tên node cho `host=node`
- `elevated` (bool): yêu cầu chế độ nâng quyền (máy chủ gateway); `security=full` chỉ bị ép buộc khi nâng quyền phân giải thành `full`

Ghi chú:

- `host` mặc định là `sandbox`.
- `elevated` bị bỏ qua khi sandboxing tắt (exec đã chạy trên host).
- Phê duyệt `gateway`/`node` được điều khiển bởi `~/.openclaw/exec-approvals.json`.
- `node` yêu cầu một node đã ghép cặp (ứng dụng đồng hành hoặc máy chủ node headless).
- Nếu có nhiều node, đặt `exec.node` hoặc `tools.exec.node` để chọn một node.
- Trên host không phải Windows, exec dùng `SHELL` khi được đặt; nếu `SHELL` là `fish`, nó ưu tiên `bash` (hoặc `sh`)
  từ `PATH` để tránh các script không tương thích với fish, rồi mới rơi về `SHELL` nếu không có.
- Thực thi trên host (`gateway`/`node`) từ chối `env.PATH` và ghi đè loader (`LD_*`/`DYLD_*`) để
  ngăn chặn chiếm đoạt binary hoặc chèn mã.
- Quan trọng: sandboxing **tắt theo mặc định**. Khi sandboxing tắt, `host=sandbox` chạy trực tiếp trên
  máy chủ gateway (không container) và **không yêu cầu phê duyệt**. Để yêu cầu phê duyệt, hãy chạy với
  `host=gateway` và cấu hình phê duyệt exec (hoặc bật sandboxing).

## Cấu hình

- `tools.exec.notifyOnExit` (mặc định: true): khi true, các phiên exec chạy nền sẽ xếp hàng một sự kiện hệ thống và yêu cầu heartbeat khi thoát.
- `tools.exec.approvalRunningNoticeMs` (mặc định: 10000): phát một thông báo “đang chạy” duy nhất khi exec có cổng phê duyệt chạy lâu hơn ngưỡng này (0 để tắt).
- `tools.exec.host` (mặc định: `sandbox`)
- `tools.exec.security` (mặc định: `deny` cho sandbox, `allowlist` cho gateway + node khi không đặt)
- `tools.exec.ask` (mặc định: `on-miss`)
- `tools.exec.node` (mặc định: không đặt)
- `tools.exec.pathPrepend`: danh sách thư mục để thêm vào đầu `PATH` cho các lần chạy exec.
- `tools.exec.safeBins`: các binary an toàn chỉ-stdin có thể chạy mà không cần mục allowlist rõ ràng.

Ví dụ:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### Xử lý PATH

- `host=gateway`: hợp nhất `PATH` của login-shell của bạn vào môi trường exec. Các ghi đè `env.PATH` bị
  từ chối đối với thực thi trên host. Bản thân daemon vẫn chạy với `PATH` tối thiểu:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: chạy `sh -lc` (login shell) bên trong container, nên `/etc/profile` có thể đặt lại `PATH`.
  OpenClaw thêm `env.PATH` vào đầu sau khi nạp profile thông qua một biến môi trường nội bộ (không nội suy shell);
  `tools.exec.pathPrepend` cũng áp dụng ở đây.
- `host=node`: chỉ các ghi đè env không bị chặn mà bạn truyền mới được gửi tới node. Các ghi đè `env.PATH` bị
  từ chối cho thực thi trên host. Các máy chủ node headless chỉ chấp nhận `PATH` khi nó thêm vào đầu PATH của node host
  (không thay thế). Node macOS loại bỏ hoàn toàn các ghi đè `PATH`.

Ràng buộc node theo từng tác tử (dùng chỉ mục danh sách tác tử trong cấu hình):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

UI điều khiển: tab Nodes bao gồm một bảng nhỏ “Exec node binding” cho cùng các thiết lập.

## Ghi đè phiên (`/exec`)

Dùng `/exec` để đặt các giá trị mặc định **theo từng phiên** cho `host`, `security`, `ask`, và `node`.
Gửi `/exec` không kèm đối số để hiển thị các giá trị hiện tại.

Ví dụ:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Mô hình ủy quyền

`/exec` chỉ được tôn trọng đối với **người gửi được ủy quyền** (allowlist kênh/ghép cặp cộng với `commands.useAccessGroups`).
Nó chỉ cập nhật **trạng thái phiên** và không ghi cấu hình. Để tắt exec một cách cứng, hãy từ chối qua
chính sách công cụ (`tools.deny: ["exec"]` hoặc theo từng tác tử). Phê duyệt trên host vẫn áp dụng trừ khi bạn đặt rõ ràng
`security=full` và `ask=off`.

## Phê duyệt Exec (ứng dụng đồng hành / máy chủ node)

Các tác tử có sandbox có thể yêu cầu phê duyệt theo từng yêu cầu trước khi `exec` chạy trên gateway hoặc máy chủ node.
Xem [Phê duyệt Exec](/tools/exec-approvals) để biết chính sách, allowlist và luồng UI.

Khi yêu cầu phê duyệt, công cụ exec trả về ngay với
`status: "approval-pending"` và một id phê duyệt. Khi được phê duyệt (hoặc bị từ chối / hết thời gian),
Gateway phát các sự kiện hệ thống (`Exec finished` / `Exec denied`). Nếu lệnh vẫn
đang chạy sau `tools.exec.approvalRunningNoticeMs`, sẽ phát một thông báo `Exec running` duy nhất.

## Allowlist + safe bin

Việc thực thi allowlist khớp **chỉ theo đường dẫn binary đã phân giải** (không khớp theo basename). Khi
`security=allowlist`, các lệnh shell chỉ được tự động cho phép nếu mọi đoạn pipeline đều
được allowlist hoặc là safe bin. Việc nối lệnh (`;`, `&&`, `||`) và chuyển hướng bị từ chối trong
chế độ allowlist.

## Ví dụ

Tiền cảnh:

```json
{ "tool": "exec", "command": "ls -la" }
```

Chạy nền + thăm dò:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Gửi phím (kiểu tmux):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Gửi (chỉ gửi CR):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Dán (mặc định có bao khung):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch (thử nghiệm)

`apply_patch` là một công cụ con của `exec` cho việc chỉnh sửa có cấu trúc nhiều tệp.
Bật một cách tường minh:

```json5
{
  tools: {
    exec: {
      applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
    },
  },
}
```

Ghi chú:

- Chỉ khả dụng cho các mô hình OpenAI/OpenAI Codex.
- Chính sách công cụ vẫn áp dụng; `allow: ["exec"]` ngầm cho phép `apply_patch`.
- Cấu hình nằm dưới `tools.exec.applyPatch`.
