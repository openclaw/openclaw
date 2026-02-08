---
summary: "Tài liệu tham chiếu CLI cho `openclaw models` (status/list/set/scan, bí danh, fallback, xác thực)"
read_when:
  - Bạn muốn thay đổi mô hình mặc định hoặc xem trạng thái xác thực của nhà cung cấp
  - Bạn muốn quét các mô hình/nhà cung cấp khả dụng và gỡ lỗi hồ sơ xác thực
title: "models"
x-i18n:
  source_path: cli/models.md
  source_hash: 923b6ffc7de382ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:23Z
---

# `openclaw models`

Khám phá, quét và cấu hình mô hình (mô hình mặc định, fallback, hồ sơ xác thực).

Liên quan:

- Nhà cung cấp + mô hình: [Models](/providers/models)
- Thiết lập xác thực nhà cung cấp: [Getting started](/start/getting-started)

## Các lệnh thường dùng

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` hiển thị mô hình mặc định/fallback đã được phân giải cùng với tổng quan xác thực.
Khi có snapshot mức sử dụng của nhà cung cấp, phần trạng thái OAuth/token sẽ bao gồm
các header mức sử dụng của nhà cung cấp.
Thêm `--probe` để chạy các probe xác thực trực tiếp đối với từng hồ sơ nhà cung cấp đã cấu hình.
Các probe là yêu cầu thực (có thể tiêu tốn token và kích hoạt giới hạn tốc độ).
Dùng `--agent <id>` để kiểm tra trạng thái mô hình/xác thực của một tác tử đã cấu hình. Khi bỏ qua,
lệnh sẽ dùng `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` nếu được đặt, nếu không thì dùng
tác tử mặc định đã cấu hình.

Ghi chú:

- `models set <model-or-alias>` chấp nhận `provider/model` hoặc một bí danh.
- Tham chiếu mô hình được phân tích bằng cách tách theo `/` **đầu tiên**. Nếu ID mô hình có `/` (kiểu OpenRouter), hãy bao gồm tiền tố nhà cung cấp (ví dụ: `openrouter/moonshotai/kimi-k2`).
- Nếu bạn bỏ qua nhà cung cấp, OpenClaw coi đầu vào là một bí danh hoặc một mô hình cho **nhà cung cấp mặc định** (chỉ hoạt động khi không có `/` trong ID mô hình).

### `models status`

Tùy chọn:

- `--json`
- `--plain`
- `--check` (thoát 1=hết hạn/thiếu, 2=sắp hết hạn)
- `--probe` (probe trực tiếp các hồ sơ xác thực đã cấu hình)
- `--probe-provider <name>` (probe một nhà cung cấp)
- `--probe-profile <id>` (lặp lại hoặc các id hồ sơ phân tách bằng dấu phẩy)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (id tác tử đã cấu hình; ghi đè `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Bí danh + fallback

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Hồ sơ xác thực

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` chạy luồng xác thực của plugin nhà cung cấp (OAuth/khóa API). Dùng
`openclaw plugins list` để xem những nhà cung cấp nào đã được cài đặt.

Ghi chú:

- `setup-token` sẽ yêu cầu giá trị setup-token (tạo bằng `claude setup-token` trên bất kỳ máy nào).
- `paste-token` chấp nhận một chuỗi token được tạo ở nơi khác hoặc từ tự động hóa.
