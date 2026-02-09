---
summary: "Tham chiếu CLI cho `openclaw nodes` (liệt kê/trạng thái/phê duyệt/gọi, camera/canvas/screen)"
read_when:
  - Bạn đang quản lý các node đã ghép đôi (camera, màn hình, canvas)
  - Bạn cần phê duyệt yêu cầu hoặc gọi các lệnh của node
title: "nodes"
---

# `openclaw nodes`

Quản lý các node (thiết bị) đã ghép đôi và gọi các khả năng của node.

Liên quan:

- Tổng quan Nodes: [Nodes](/nodes)
- Camera: [Camera nodes](/nodes/camera)
- Hình ảnh: [Image nodes](/nodes/images)

Tùy chọn chung:

- `--url`, `--token`, `--timeout`, `--json`

## Lệnh dùng chung

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` in ra các bảng đang chờ/đã ghép cặp. Các hàng đã ghép cặp bao gồm tuổi kết nối gần nhất (Last Connect).
Dùng `--connected` để chỉ hiển thị các node hiện đang kết nối. Dùng `--last-connected <duration>` để
lọc các node đã kết nối trong một khoảng thời gian (ví dụ: `24h`, `7d`).

## Gọi / chạy

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Cờ gọi:

- `--params <json>`: chuỗi đối tượng JSON (mặc định `{}`).
- `--invoke-timeout <ms>`: thời gian chờ gọi node (mặc định `15000`).
- `--idempotency-key <key>`: khóa idempotency tùy chọn.

### Mặc định kiểu exec

`nodes run` phản chiếu hành vi exec của mô hình (mặc định + phê duyệt):

- Đọc `tools.exec.*` (cộng với các ghi đè `agents.list[].tools.exec.*`).
- Dùng các phê duyệt exec (`exec.approval.request`) trước khi gọi `system.run`.
- Có thể bỏ `--node` khi `tools.exec.node` được đặt.
- Yêu cầu một node quảng bá `system.run` (ứng dụng đồng hành macOS hoặc máy chủ node headless).

Cờ:

- `--cwd <path>`: thư mục làm việc.
- `--env <key=val>`: ghi đè env (có thể lặp).
- `--command-timeout <ms>`: thời gian chờ lệnh.
- `--invoke-timeout <ms>`: thời gian chờ gọi node (mặc định `30000`).
- `--needs-screen-recording`: yêu cầu quyền ghi màn hình.
- `--raw <command>`: chạy một chuỗi shell (`/bin/sh -lc` hoặc `cmd.exe /c`).
- `--agent <id>`: phê duyệt/danh sách cho phép theo phạm vi tác tử (mặc định là tác tử đã cấu hình).
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: ghi đè.
