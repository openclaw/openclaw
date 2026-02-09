---
summary: "Cách dùng công cụ Exec, các chế độ stdin và hỗ trợ TTY"
read_when:
  - Khi dùng hoặc chỉnh sửa công cụ exec
  - Khi gỡ lỗi hành vi stdin hoặc TTY
title: "Công cụ Exec"
---

# Công cụ Exec

Chạy lệnh shell trong workspace. Hỗ trợ thực thi tiền cảnh + hậu cảnh thông qua `process`.
Nếu `process` bị từ chối, `exec` chạy đồng bộ và bỏ qua `yieldMs`/`background`.
Background sessions are scoped per agent; `process` only sees sessions from the same agent.

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
- Quan trọng: sandboxing **tắt theo mặc định**. If sandboxing is off, `host=sandbox` runs directly on
  the gateway host (no container) and **does not require approvals**. Để yêu cầu phê duyệt, hãy chạy với
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
  từ chối cho thực thi trên host. Bản thân daemon vẫn chạy với một `PATH` tối thiểu:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: chạy `sh -lc` (login shell) bên trong container, vì vậy `/etc/profile` có thể đặt lại `PATH`.
  OpenClaw prepends `env.PATH` after profile sourcing via an internal env var (no shell interpolation);
  `tools.exec.pathPrepend` applies here too.
- `host=node`: chỉ các ghi đè env không bị chặn mà bạn truyền vào mới được gửi tới node. Các ghi đè `env.PATH` bị
  từ chối cho thực thi trên host. Các node host headless chỉ chấp nhận `PATH` khi nó được thêm tiền tố vào
  PATH của node host (không thay thế). Các node macOS loại bỏ hoàn toàn các ghi đè `PATH`.

Ràng buộc node theo từng tác tử (dùng chỉ mục danh sách tác tử trong cấu hình):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

UI điều khiển: tab Nodes bao gồm một bảng nhỏ “Exec node binding” cho cùng các thiết lập.

## Ghi đè phiên (`/exec`)

Use `/exec` to set **per-session** defaults for `host`, `security`, `ask`, and `node`.
Gửi `/exec` không kèm đối số để hiển thị các giá trị hiện tại.

Ví dụ:

```
/exec host=gateway security=allowlist ask=on-miss node=mac-1
```

## Mô hình ủy quyền

`/exec` is only honored for **authorized senders** (channel allowlists/pairing plus `commands.useAccessGroups`).
It updates **session state only** and does not write config. To hard-disable exec, deny it via tool
policy (`tools.deny: ["exec"]` or per-agent). Host approvals still apply unless you explicitly set
`security=full` and `ask=off`.

## Phê duyệt Exec (ứng dụng đồng hành / máy chủ node)

Sandboxed agents can require per-request approval before `exec` runs on the gateway or node host.
See [Exec approvals](/tools/exec-approvals) for the policy, allowlist, and UI flow.

When approvals are required, the exec tool returns immediately with
`status: "approval-pending"` and an approval id. Once approved (or denied / timed out),
the Gateway emits system events (`Exec finished` / `Exec denied`). If the command is still
running after `tools.exec.approvalRunningNoticeMs`, a single `Exec running` notice is emitted.

## Allowlist + safe bin

Allowlist enforcement matches **resolved binary paths only** (no basename matches). When
`security=allowlist`, shell commands are auto-allowed only if every pipeline segment is
allowlisted or a safe bin. Chaining (`;`, `&&`, `||`) and redirections are rejected in
allowlist mode.

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

`apply_patch` is a subtool of `exec` for structured multi-file edits.
Enable it explicitly:

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
