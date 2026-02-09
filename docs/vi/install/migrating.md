---
summary: "Di chuyển (migrate) một cài đặt OpenClaw từ máy này sang máy khác"
read_when:
  - Bạn đang chuyển OpenClaw sang laptop/server mới
  - Bạn muốn giữ nguyên phiên, xác thực và đăng nhập kênh (WhatsApp, v.v.)
title: "Hướng dẫn Migration"
---

# Migrating OpenClaw sang máy mới

Hướng dẫn này giúp migrate một OpenClaw Gateway từ máy này sang máy khác **mà không cần làm lại onboarding**.

Về mặt khái niệm, việc migration khá đơn giản:

- Sao chép **thư mục trạng thái** (`$OPENCLAW_STATE_DIR`, mặc định: `~/.openclaw/`) — bao gồm cấu hình, xác thực, phiên và trạng thái kênh.
- Sao chép **workspace** của bạn (`~/.openclaw/workspace/` theo mặc định) — bao gồm các tệp tác tử (memory, prompt, v.v.).

Tuy nhiên, có những “bẫy” phổ biến liên quan đến **profile**, **quyền truy cập**, và **sao chép không đầy đủ**.

## Trước khi bắt đầu (bạn đang migrate những gì)

### 1. Xác định thư mục trạng thái

Hầu hết các cài đặt dùng mặc định:

- **State dir:** `~/.openclaw/`

Nhưng có thể khác nếu bạn dùng:

- `--profile <name>` (thường trở thành `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Nếu không chắc, hãy chạy trên máy **cũ**:

```bash
openclaw status
```

Tìm các đề cập đến `OPENCLAW_STATE_DIR` / profile trong output. Nếu bạn chạy nhiều gateway, hãy lặp lại cho từng profile.

### 2. Xác định workspace

Các mặc định phổ biến:

- `~/.openclaw/workspace/` (workspace được khuyến nghị)
- một thư mục tùy chỉnh bạn đã tạo

Workspace là nơi chứa các tệp như `MEMORY.md`, `USER.md`, và `memory/*.md`.

### 3. Hiểu những gì sẽ được giữ lại

Nếu bạn sao chép **cả** state dir và workspace, bạn sẽ giữ:

- Cấu hình Gateway (`openclaw.json`)
- Profile xác thực / khóa API / token OAuth
- Lịch sử phiên + trạng thái tác tử
- Trạng thái kênh (ví dụ: đăng nhập/phiên WhatsApp)
- Các tệp workspace của bạn (memory, ghi chú skills, v.v.)

Nếu bạn **chỉ** sao chép workspace (ví dụ qua Git), bạn **không** giữ:

- phiên
- thông tin xác thực
- đăng nhập kênh

Những thứ này nằm dưới `$OPENCLAW_STATE_DIR`.

## Các bước migration (khuyến nghị)

### Bước 0 — Tạo bản sao lưu (máy cũ)

Trên máy **cũ**, hãy dừng gateway trước để tránh thay đổi tệp trong lúc sao chép:

```bash
openclaw gateway stop
```

(Tùy chọn nhưng khuyến nghị) nén state dir và workspace:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Nếu bạn có nhiều profile/state dir (ví dụ: `~/.openclaw-main`, `~/.openclaw-work`), hãy nén từng cái.

### Bước 1 — Cài OpenClaw trên máy mới

Trên máy **mới**, cài CLI (và Node nếu cần):

- Xem: [Install](/install)

Ở giai đoạn này, việc onboarding tạo ra một `~/.openclaw/` mới là bình thường — bạn sẽ ghi đè nó ở bước tiếp theo.

### Bước 2 — Sao chép state dir + workspace sang máy mới

Sao chép **cả hai**:

- `$OPENCLAW_STATE_DIR` (mặc định `~/.openclaw/`)
- workspace của bạn (mặc định `~/.openclaw/workspace/`)

Các cách phổ biến:

- `scp` các tarball và giải nén
- `rsync -a` qua SSH
- ổ đĩa ngoài

Sau khi sao chép, đảm bảo:

- Đã bao gồm các thư mục ẩn (ví dụ: `.openclaw/`)
- Quyền sở hữu tệp đúng với người dùng chạy gateway

### Bước 3 — Chạy Doctor (migration + sửa dịch vụ)

Trên máy **mới**:

```bash
openclaw doctor
```

Doctor là lệnh “an toàn và nhàm chán”. It repairs services, applies config migrations, and warns about mismatches.

Sau đó:

```bash
openclaw gateway restart
openclaw status
```

## Các “bẫy” thường gặp (và cách tránh)

### Bẫy: không khớp profile / state-dir

Nếu bạn chạy gateway cũ với một profile (hoặc `OPENCLAW_STATE_DIR`), và gateway mới dùng profile khác, bạn sẽ thấy các dấu hiệu như:

- thay đổi cấu hình không có hiệu lực
- thiếu kênh / bị đăng xuất
- lịch sử phiên trống

Cách khắc phục: chạy gateway/dịch vụ với **cùng** profile/state dir mà bạn đã migrate, sau đó chạy lại:

```bash
openclaw doctor
```

### Bẫy: chỉ sao chép `openclaw.json`

`openclaw.json` is not enough. Nhiều nhà cung cấp lưu state tại:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Luôn migrate toàn bộ thư mục `$OPENCLAW_STATE_DIR`.

### Bẫy: quyền truy cập / quyền sở hữu

Nếu bạn sao chép bằng root hoặc đổi người dùng, gateway có thể không đọc được thông tin xác thực/phiên.

Cách khắc phục: đảm bảo state dir + workspace thuộc quyền sở hữu của người dùng chạy gateway.

### Bẫy: migrate giữa chế độ remote/local

- Nếu UI (WebUI/TUI) của bạn trỏ tới một gateway **remote**, máy chủ remote sở hữu kho phiên + workspace.
- Việc migrate laptop của bạn sẽ không di chuyển trạng thái của gateway remote.

Nếu bạn đang ở chế độ remote, hãy migrate **máy chủ gateway**.

### Bẫy: bí mật trong bản sao lưu

`$OPENCLAW_STATE_DIR` contains secrets (API keys, OAuth tokens, WhatsApp creds). Hãy đối xử với bản sao lưu như các bí mật production:

- lưu trữ có mã hóa
- tránh chia sẻ qua kênh không an toàn
- xoay vòng khóa nếu nghi ngờ bị lộ

## Danh sách kiểm tra xác minh

Trên máy mới, xác nhận:

- `openclaw status` hiển thị gateway đang chạy
- Các kênh vẫn được kết nối (ví dụ: WhatsApp không yêu cầu ghép lại)
- Bảng điều khiển mở được và hiển thị các phiên hiện có
- Các tệp workspace (memory, cấu hình) vẫn còn

## Liên quan

- [Doctor](/gateway/doctor)
- [Gateway troubleshooting](/gateway/troubleshooting)
- [OpenClaw lưu dữ liệu ở đâu?](/help/faq#where-does-openclaw-store-its-data)
