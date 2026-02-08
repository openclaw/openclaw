---
summary: "Cách sandboxing của OpenClaw hoạt động: chế độ, phạm vi, quyền truy cập workspace và image"
title: Sandboxing
read_when: "Bạn muốn một giải thích chuyên biệt về sandboxing hoặc cần tinh chỉnh agents.defaults.sandbox."
status: active
x-i18n:
  source_path: gateway/sandboxing.md
  source_hash: c1bb7fd4ac37ef73
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:18Z
---

# Sandboxing

OpenClaw có thể chạy **các tool bên trong container Docker** để giảm phạm vi ảnh hưởng khi xảy ra sự cố.
Tính năng này **không bắt buộc** và được kiểm soát bằng cấu hình (`agents.defaults.sandbox` hoặc
`agents.list[].sandbox`). Nếu sandboxing tắt, các tool sẽ chạy trên host.
Gateway vẫn chạy trên host; việc thực thi tool sẽ diễn ra trong sandbox cô lập
khi được bật.

Đây không phải là ranh giới bảo mật hoàn hảo, nhưng nó hạn chế đáng kể quyền truy cập
hệ thống tệp và tiến trình khi mô hình làm điều gì đó không đúng.

## Những gì được sandbox

- Thực thi tool (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, v.v.).
- Trình duyệt sandbox tùy chọn (`agents.defaults.sandbox.browser`).
  - Theo mặc định, trình duyệt sandbox tự khởi động (đảm bảo CDP có thể truy cập) khi tool trình duyệt cần dùng.
    Cấu hình qua `agents.defaults.sandbox.browser.autoStart` và `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` cho phép các phiên sandbox nhắm trực tiếp tới trình duyệt trên host.
  - Các allowlist tùy chọn kiểm soát `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Không sandbox:

- Chính tiến trình Gateway.
- Bất kỳ tool nào được cho phép chạy trên host một cách rõ ràng (ví dụ: `tools.elevated`).
  - **Thực thi nâng quyền chạy trên host và bỏ qua sandboxing.**
  - Nếu sandboxing tắt, `tools.elevated` không thay đổi cách thực thi (đã chạy trên host). Xem [Elevated Mode](/tools/elevated).

## Chế độ

`agents.defaults.sandbox.mode` kiểm soát **khi nào** sandboxing được sử dụng:

- `"off"`: không sandboxing.
- `"non-main"`: chỉ sandbox các phiên **không phải main** (mặc định nếu bạn muốn các cuộc chat bình thường chạy trên host).
- `"all"`: mọi phiên đều chạy trong sandbox.
  Lưu ý: `"non-main"` dựa trên `session.mainKey` (mặc định `"main"`), không dựa trên id của agent.
  Các phiên nhóm/kênh dùng khóa riêng, vì vậy được tính là không phải main và sẽ bị sandbox.

## Phạm vi

`agents.defaults.sandbox.scope` kiểm soát **số lượng container** được tạo:

- `"session"` (mặc định): một container cho mỗi phiên.
- `"agent"`: một container cho mỗi agent.
- `"shared"`: một container dùng chung cho tất cả các phiên sandbox.

## Quyền truy cập workspace

`agents.defaults.sandbox.workspaceAccess` kiểm soát **những gì sandbox có thể nhìn thấy**:

- `"none"` (mặc định): các tool thấy một workspace sandbox dưới `~/.openclaw/sandboxes`.
- `"ro"`: gắn workspace của agent ở chế độ chỉ đọc tại `/agent` (vô hiệu hóa `write`/`edit`/`apply_patch`).
- `"rw"`: gắn workspace của agent ở chế độ đọc/ghi tại `/workspace`.

Media đầu vào được sao chép vào workspace sandbox đang hoạt động (`media/inbound/*`).
Lưu ý về Skills: tool `read` được neo gốc theo sandbox. Với `workspaceAccess: "none"`,
OpenClaw phản chiếu các skill đủ điều kiện vào workspace sandbox (`.../skills`) để
có thể đọc. Với `"rw"`, các skill trong workspace có thể đọc từ
`/workspace/skills`.

## Gắn bind tùy chỉnh

`agents.defaults.sandbox.docker.binds` gắn thêm các thư mục trên host vào container.
Định dạng: `host:container:mode` (ví dụ: `"/home/user/source:/source:rw"`).

Các bind toàn cục và theo agent được **gộp** (không bị thay thế). Dưới `scope: "shared"`, các bind theo agent sẽ bị bỏ qua.

Ví dụ (nguồn chỉ đọc + socket Docker):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Ghi chú bảo mật:

- Các bind bỏ qua hệ thống tệp sandbox: chúng phơi bày đường dẫn trên host với chế độ bạn đặt (`:ro` hoặc `:rw`).
- Các mount nhạy cảm (ví dụ: `docker.sock`, secrets, khóa SSH) nên để `:ro` trừ khi thực sự cần.
- Kết hợp với `workspaceAccess: "ro"` nếu bạn chỉ cần quyền đọc workspace; chế độ bind vẫn độc lập.
- Xem [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) để biết cách bind tương tác với chính sách tool và thực thi nâng quyền.

## Image + thiết lập

Image mặc định: `openclaw-sandbox:bookworm-slim`

Build một lần:

```bash
scripts/sandbox-setup.sh
```

Lưu ý: image mặc định **không** bao gồm Node. Nếu một skill cần Node (hoặc
các runtime khác), hãy bake một image tùy chỉnh hoặc cài qua
`sandbox.docker.setupCommand` (yêu cầu egress mạng + root có thể ghi +
người dùng root).

Image trình duyệt sandbox:

```bash
scripts/sandbox-browser-setup.sh
```

Theo mặc định, các container sandbox chạy với **không có mạng**.
Ghi đè bằng `agents.defaults.sandbox.docker.network`.

Cài đặt Docker và gateway chạy trong container nằm tại đây:
[Docker](/install/docker)

## setupCommand (thiết lập container một lần)

`setupCommand` chạy **một lần** sau khi container sandbox được tạo (không chạy mỗi lần).
Nó thực thi bên trong container qua `sh -lc`.

Đường dẫn:

- Toàn cục: `agents.defaults.sandbox.docker.setupCommand`
- Theo agent: `agents.list[].sandbox.docker.setupCommand`

Các lỗi thường gặp:

- `docker.network` mặc định là `"none"` (không egress), nên cài gói sẽ thất bại.
- `readOnlyRoot: true` chặn ghi; đặt `readOnlyRoot: false` hoặc bake image tùy chỉnh.
- `user` phải là root để cài gói (bỏ `user` hoặc đặt `user: "0:0"`).
- Thực thi sandbox **không** kế thừa `process.env` của host. Hãy dùng
  `agents.defaults.sandbox.docker.env` (hoặc image tùy chỉnh) cho khóa API của skill.

## Chính sách tool + lối thoát

Chính sách cho phép/từ chối tool vẫn được áp dụng trước các quy tắc sandbox. Nếu một tool bị từ chối
toàn cục hoặc theo agent, sandboxing không khôi phục lại nó.

`tools.elevated` là một lối thoát rõ ràng để chạy `exec` trên host.
Các chỉ thị `/exec` chỉ áp dụng cho người gửi được ủy quyền và được lưu theo phiên; để vô hiệu hóa cứng
`exec`, hãy dùng chính sách tool deny (xem [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Gỡ lỗi:

- Dùng `openclaw sandbox explain` để kiểm tra chế độ sandbox hiệu lực, chính sách tool và các khóa cấu hình gợi ý sửa.
- Xem [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) để hiểu mô hình tư duy “vì sao bị chặn?”.
  Hãy giữ cấu hình chặt chẽ.

## Ghi đè đa agent

Mỗi agent có thể ghi đè sandbox + tool:
`agents.list[].sandbox` và `agents.list[].tools` (cộng thêm `agents.list[].tools.sandbox.tools` cho chính sách tool của sandbox).
Xem [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) để biết thứ tự ưu tiên.

## Ví dụ bật tối thiểu

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Tài liệu liên quan

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
