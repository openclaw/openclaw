---
title: Sandbox so với Chính sách Tool so với Elevated
summary: "Vì sao một tool bị chặn: runtime sandbox, chính sách cho phép/chặn tool, và các cổng thực thi elevated"
read_when: "Khi bạn gặp 'sandbox jail' hoặc thấy tool/elevated bị từ chối và muốn biết chính xác khóa cấu hình cần thay đổi."
status: active
---

# Sandbox so với Chính sách Tool so với Elevated

OpenClaw có ba cơ chế liên quan (nhưng khác nhau):

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) quyết định **tool chạy ở đâu** (Docker hay host).
2. **Chính sách tool** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) quyết định **tool nào có sẵn/được phép**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) là **lối thoát chỉ dành cho exec** để chạy trên host khi bạn đang ở trong sandbox.

## Gỡ lỗi nhanh

Dùng inspector để xem OpenClaw _thực sự_ đang làm gì:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Nó in ra:

- chế độ/phạm vi sandbox/quyền truy cập workspace đang áp dụng
- phiên hiện tại có đang bị sandbox hay không (main so với không-main)
- allow/deny tool của sandbox đang áp dụng (và nó đến từ agent/toàn cục/mặc định)
- các cổng elevated và đường dẫn khóa cấu hình để sửa

## Sandbox: nơi tool chạy

Sandboxing được điều khiển bởi `agents.defaults.sandbox.mode`:

- `"off"`: mọi thứ chạy trên host.
- `"non-main"`: chỉ các phiên không-main bị sandbox (nguồn “bất ngờ” phổ biến với group/kênh).
- `"all"`: mọi thứ đều bị sandbox.

Xem [Sandboxing](/gateway/sandboxing) để biết đầy đủ ma trận (phạm vi, mount workspace, image).

### Bind mount (kiểm tra nhanh về bảo mật)

- `docker.binds` _xuyên thủng_ filesystem của sandbox: bất cứ thứ gì bạn mount sẽ hiển thị trong container với chế độ bạn đặt (`:ro` hoặc `:rw`).
- Mặc định là đọc-ghi nếu bạn bỏ qua chế độ; nên ưu tiên `:ro` cho mã nguồn/bí mật.
- `scope: "shared"` bỏ qua bind theo từng tác tử (chỉ áp dụng bind toàn cục).
- Bind `/var/run/docker.sock` về cơ bản trao quyền kiểm soát host cho sandbox; chỉ làm điều này khi có chủ đích.
- Quyền truy cập workspace (`workspaceAccess: "ro"`/`"rw"`) độc lập với chế độ bind.

## Chính sách tool: tool nào tồn tại/có thể gọi

Hai lớp chính cần quan tâm:

- **Hồ sơ tool**: `tools.profile` và `agents.list[].tools.profile` (allowlist cơ sở)
- **Hồ sơ tool của provider**: `tools.byProvider[provider].profile` và `agents.list[].tools.byProvider[provider].profile`
- **Chính sách tool toàn cục/theo tác tử**: `tools.allow`/`tools.deny` và `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Chính sách tool của provider**: `tools.byProvider[provider].allow/deny` và `agents.list[].tools.byProvider[provider].allow/deny`
- **Chính sách tool của sandbox** (chỉ áp dụng khi bị sandbox): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` và `agents.list[].tools.sandbox.tools.*`

Quy tắc kinh nghiệm:

- `deny` luôn thắng.
- Nếu `allow` không rỗng, mọi thứ khác được xem là bị chặn.
- Chính sách tool là điểm dừng cứng: `/exec` không thể ghi đè một tool `exec` đã bị từ chối.
- `/exec` chỉ thay đổi các mặc định của phiên cho các bên gửi được ủy quyền; nó không cấp quyền truy cập công cụ.
  Khóa công cụ của nhà cung cấp chấp nhận либо `provider` (ví dụ: `google-antigravity`) hoặc `provider/model` (ví dụ: `openai/gpt-5.2`).

### Nhóm tool (viết tắt)

Chính sách tool (toàn cục, theo tác tử, sandbox) hỗ trợ các mục `group:*` mở rộng thành nhiều tool:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Các nhóm có sẵn:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: tất cả tool tích hợp sẵn của OpenClaw (không bao gồm plugin provider)

## Elevated: exec-only “chạy trên host”

Elevated **không** cấp thêm tool; nó chỉ ảnh hưởng đến `exec`.

- Nếu bạn đang bị sandbox, `/elevated on` (hoặc `exec` với `elevated: true`) sẽ chạy trên host (vẫn có thể cần phê duyệt).
- Dùng `/elevated full` để bỏ qua phê duyệt exec cho phiên.
- Nếu bạn đã chạy trực tiếp, elevated về cơ bản không có tác dụng (vẫn bị chặn bởi cổng).
- Elevated **không** theo phạm vi skill và **không** ghi đè allow/deny của tool.
- `/exec` tách biệt với elevated. Nó chỉ điều chỉnh các mặc định exec theo từng phiên cho các bên gửi được ủy quyền.

Các cổng:

- Bật/tắt: `tools.elevated.enabled` (và tùy chọn `agents.list[].tools.elevated.enabled`)
- Danh sách cho phép người gửi: `tools.elevated.allowFrom.<provider>`` (và tùy chọn `agents.list[].tools.elevated.allowFrom.<provider>\`\`)

Xem [Elevated Mode](/tools/elevated).

## Các cách sửa “sandbox jail” thường gặp

### “Tool X bị chặn bởi chính sách tool của sandbox”

Khóa để sửa (chọn một):

- Tắt sandbox: `agents.defaults.sandbox.mode=off` (hoặc theo tác tử `agents.list[].sandbox.mode=off`)
- Cho phép tool bên trong sandbox:
  - gỡ nó khỏi `tools.sandbox.tools.deny` (hoặc theo tác tử `agents.list[].tools.sandbox.tools.deny`)
  - hoặc thêm nó vào `tools.sandbox.tools.allow` (hoặc allow theo tác tử)

### “Tôi tưởng đây là main, sao lại bị sandbox?”

Trong chế độ `"non-main"`, các khóa nhóm/kênh _không_ phải là main. Sử dụng khóa phiên main (hiển thị bởi `sandbox explain`) hoặc chuyển chế độ sang `"off"`.
