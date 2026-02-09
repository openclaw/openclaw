---
title: Sandbox CLI
summary: "Quản lý các container sandbox và kiểm tra chính sách sandbox hiệu lực"
read_when: "Khi bạn đang quản lý các container sandbox hoặc gỡ lỗi hành vi sandbox/chính sách công cụ."
status: active
---

# Sandbox CLI

Quản lý các container sandbox dựa trên Docker để thực thi tác tử một cách cô lập.

## Tổng quan

Nó sử dụng
cách đặt tên container của Gateway và tránh sai lệch khi các khóa phạm vi/phiên thay đổi. Các lệnh `sandbox` giúp bạn quản lý các container này, đặc biệt sau khi cập nhật hoặc thay đổi cấu hình.

## Lệnh

### `openclaw sandbox explain`

Kiểm tra **hiệu lực** của chế độ/phạm vi/quyền truy cập workspace của sandbox, chính sách công cụ sandbox, và các cổng nâng quyền (kèm đường dẫn khóa cấu hình fix-it).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Liệt kê tất cả các container sandbox cùng trạng thái và cấu hình của chúng.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**Đầu ra bao gồm:**

- Tên container và trạng thái (đang chạy/dừng)
- Ảnh Docker và việc nó có khớp với cấu hình hay không
- Tuổi (thời gian kể từ khi tạo)
- Thời gian nhàn rỗi (thời gian kể từ lần sử dụng cuối)
- Phiên/tác tử liên kết

### `openclaw sandbox recreate`

Xóa các container sandbox để buộc tạo lại với ảnh/cấu hình đã cập nhật.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Tùy chọn:**

- `--all`: Tạo lại tất cả các container sandbox
- `--session <key>`: Tạo lại container cho một phiên cụ thể
- `--agent <id>`: Tạo lại các container cho một tác tử cụ thể
- `--browser`: Chỉ tạo lại các container trình duyệt
- `--force`: Bỏ qua lời nhắc xác nhận

**Quan trọng:** Các container sẽ được tự động tạo lại khi tác tử được sử dụng lần tiếp theo.

## Trường hợp sử dụng

### Sau khi cập nhật ảnh Docker

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Sau khi thay đổi cấu hình sandbox

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Sau khi thay đổi setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Chỉ cho một tác tử cụ thể

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Vì sao cần điều này?

**Vấn đề:** Khi bạn cập nhật ảnh Docker sandbox hoặc cấu hình:

- Các container hiện có tiếp tục chạy với thiết lập cũ
- Container chỉ được dọn dẹp sau 24 giờ không hoạt động
- Các tác tử được sử dụng thường xuyên giữ các container cũ chạy vô thời hạn

**Giải pháp:** Dùng `openclaw sandbox recreate` để buộc xóa các container cũ. Chúng sẽ được tạo lại tự động với các thiết lập hiện tại khi cần lần tiếp theo.

Mẹo: ưu tiên `openclaw sandbox recreate` hơn là `docker rm` thủ công. Nó cũng cảnh báo khi các mô hình nhỏ (`<=300B`) được dùng mà không có sandbox và có bật công cụ web/trình duyệt.

## Cấu hình

Thiết lập sandbox nằm trong `~/.openclaw/openclaw.json` dưới `agents.defaults.sandbox` (ghi đè theo từng tác tử nằm trong `agents.list[].sandbox`):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## Xem thêm

- [Tài liệu Sandbox](/gateway/sandboxing)
- [Cấu hình Tác tử](/concepts/agent-workspace)
- [Lệnh Doctor](/gateway/doctor) - Kiểm tra thiết lập sandbox
