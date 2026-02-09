---
summary: "Tham chiếu CLI cho `openclaw update` (cập nhật nguồn an toàn tương đối + tự động khởi động lại gateway)"
read_when:
  - Bạn muốn cập nhật một bản checkout nguồn một cách an toàn
  - Bạn cần hiểu hành vi viết tắt `--update`
title: "update"
---

# `openclaw update`

Cập nhật OpenClaw một cách an toàn và chuyển đổi giữa các kênh stable/beta/dev.

Nếu bạn cài đặt qua **npm/pnpm** (cài đặt toàn cục, không có metadata git), việc cập nhật diễn ra theo luồng của trình quản lý gói trong [Updating](/install/updating).

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: bỏ qua việc khởi động lại dịch vụ Gateway sau khi cập nhật thành công.
- `--channel <stable|beta|dev>`: đặt kênh cập nhật (git + npm; được lưu trong cấu hình).
- `--tag <dist-tag|version>`: ghi đè dist-tag hoặc phiên bản npm chỉ cho lần cập nhật này.
- `--json`: in JSON `UpdateRunResult` có thể đọc bằng máy.
- `--timeout <seconds>`: thời gian chờ cho mỗi bước (mặc định là 1200s).

Lưu ý: hạ cấp phiên bản cần xác nhận vì các phiên bản cũ có thể làm hỏng cấu hình.

## `update status`

Hiển thị kênh cập nhật đang hoạt động + thẻ/nhánh/SHA git (đối với bản checkout nguồn), cùng với tình trạng có bản cập nhật hay không.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options:

- `--json`: in JSON trạng thái có thể đọc bằng máy.
- `--timeout <seconds>`: thời gian chờ cho kiểm tra (mặc định là 3s).

## `update wizard`

Nếu bạn chọn `dev` mà không có bản checkout git, nó
sẽ đề nghị tạo một bản. `voicecall` là một lệnh do plugin cung cấp.

## What it does

Khi bạn chuyển kênh một cách tường minh (`--channel ...`), OpenClaw cũng giữ cho
phương thức cài đặt được căn chỉnh:

- `dev` → đảm bảo có một bản checkout git (mặc định: `~/openclaw`, ghi đè bằng `OPENCLAW_GIT_DIR`),
  cập nhật nó và cài đặt CLI toàn cục từ bản checkout đó.
- `stable`/`beta` → cài đặt từ npm bằng dist-tag tương ứng.

## Git checkout flow

Channels:

- `stable`: checkout thẻ non-beta mới nhất, sau đó build + doctor.
- `beta`: checkout thẻ `-beta` mới nhất, sau đó build + doctor.
- `dev`: checkout `main`, sau đó fetch + rebase.

High-level:

1. Yêu cầu worktree sạch (không có thay đổi chưa commit).
2. Chuyển sang kênh đã chọn (thẻ hoặc nhánh).
3. Fetch upstream (chỉ dev).
4. Chỉ dev: lint tiền kiểm + build TypeScript trong một worktree tạm; nếu tip thất bại, lùi tối đa 10 commit để tìm bản build sạch mới nhất.
5. Rebase lên commit đã chọn (chỉ dev).
6. Cài đặt phụ thuộc (ưu tiên pnpm; npm dự phòng).
7. Build + build Control UI.
8. Chạy `openclaw doctor` như bước kiểm tra “cập nhật an toàn” cuối cùng.
9. Đồng bộ plugin theo kênh đang hoạt động (dev dùng các extension đóng gói sẵn; stable/beta dùng npm) và cập nhật các plugin cài bằng npm.

## `--update` shorthand

`openclaw --update` được viết lại thành `openclaw update` (hữu ích cho shell và script khởi chạy).

## See also

- `openclaw doctor` (đề nghị chạy cập nhật trước trên các bản checkout git)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
