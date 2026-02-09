---
summary: "Models CLI: liệt kê, đặt, bí danh, dự phòng, quét, trạng thái"
read_when:
  - Thêm hoặc chỉnh sửa Models CLI (models list/set/scan/aliases/fallbacks)
  - Thay đổi hành vi dự phòng mô hình hoặc UX chọn mô hình
  - Cập nhật các probe quét mô hình (tools/images)
title: "Models CLI"
---

# Models CLI

See [/concepts/model-failover](/concepts/model-failover) for auth profile
rotation, cooldowns, and how that interacts with fallbacks.
Tổng quan nhanh về provider + ví dụ: [/concepts/model-providers](/concepts/model-providers).

## Cách chọn mô hình hoạt động

OpenClaw chọn mô hình theo thứ tự sau:

1. **Primary** model (`agents.defaults.model.primary` hoặc `agents.defaults.model`).
2. **Fallbacks** trong `agents.defaults.model.fallbacks` (theo thứ tự).
3. **Failover xác thực của nhà cung cấp** diễn ra bên trong một nhà cung cấp trước khi chuyển sang mô hình tiếp theo.

Liên quan:

- `agents.defaults.models` là allowlist/danh mục các mô hình mà OpenClaw có thể dùng (kèm bí danh).
- `agents.defaults.imageModel` chỉ được dùng **khi** primary model không chấp nhận hình ảnh.
- Mặc định theo từng tác tử có thể ghi đè `agents.defaults.model` thông qua `agents.list[].model` cộng với bindings (xem [/concepts/multi-agent](/concepts/multi-agent)).

## Gợi ý chọn mô hình nhanh (mang tính trải nghiệm)

- **GLM**: nhỉnh hơn một chút cho lập trình/gọi công cụ.
- **MiniMax**: tốt hơn cho viết lách và cảm xúc.

## Trình hướng dẫn thiết lập (khuyến nghị)

Nếu bạn không muốn chỉnh sửa cấu hình thủ công, hãy chạy trình hướng dẫn onboarding:

```bash
openclaw onboard
```

Trình này có thể thiết lập mô hình + xác thực cho các nhà cung cấp phổ biến, bao gồm **OpenAI Code (Codex)
subscription** (OAuth) và **Anthropic** (khuyến nghị API key; cũng hỗ trợ `claude
setup-token`).

## Khóa cấu hình (tổng quan)

- `agents.defaults.model.primary` và `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` và `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (allowlist + bí danh + tham số nhà cung cấp)
- `models.providers` (nhà cung cấp tùy chỉnh được ghi vào `models.json`)

Tham chiếu model được chuẩn hóa về chữ thường. Provider aliases like `z.ai/*` normalize
to `zai/*`.

Ví dụ cấu hình nhà cung cấp (bao gồm OpenCode Zen) có tại
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## “Model is not allowed” (và vì sao phản hồi bị dừng)

Nếu `agents.defaults.models` được đặt, nó trở thành **allowlist** cho `/model` và cho các ghi đè trong phiên. Khi người dùng chọn một model không nằm trong allowlist đó, OpenClaw trả về:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

This happens **before** a normal reply is generated, so the message can feel
like it “didn’t respond.” Cách khắc phục là một trong hai:

- Thêm mô hình vào `agents.defaults.models`, hoặc
- Xóa allowlist (loại bỏ `agents.defaults.models`), hoặc
- Chọn một mô hình từ `/model list`.

Ví dụ cấu hình allowlist:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Chuyển đổi mô hình trong chat (`/model`)

Bạn có thể chuyển mô hình cho phiên hiện tại mà không cần khởi động lại:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Ghi chú:

- `/model` (và `/model list`) là bộ chọn gọn nhẹ, đánh số (họ mô hình + các nhà cung cấp khả dụng).
- `/model <#>` chọn từ bộ chọn đó.
- `/model status` là chế độ xem chi tiết (các ứng viên xác thực và, khi được cấu hình, endpoint nhà cung cấp `baseUrl` + chế độ `api`).
- Tham chiếu model được phân tích bằng cách tách theo dấu `/` **đầu tiên**. Sử dụng `provider/model` khi nhập `/model <ref>`.
- Nếu ID mô hình tự nó chứa `/` (kiểu OpenRouter), bạn phải bao gồm tiền tố nhà cung cấp (ví dụ: `/model openrouter/moonshotai/kimi-k2`).
- Nếu bạn bỏ qua nhà cung cấp, OpenClaw coi đầu vào là một bí danh hoặc một mô hình cho **nhà cung cấp mặc định** (chỉ hoạt động khi không có `/` trong ID mô hình).

Hành vi/lập cấu hình đầy đủ của lệnh: [Slash commands](/tools/slash-commands).

## Lệnh CLI

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (không có lệnh con) là phím tắt cho `models status`.

### `models list`

Shows configured models by default. Các cờ hữu ích:

- `--all`: toàn bộ danh mục
- `--local`: chỉ nhà cung cấp cục bộ
- `--provider <name>`: lọc theo nhà cung cấp
- `--plain`: mỗi dòng một mô hình
- `--json`: đầu ra đọc được bằng máy

### `models status`

Hiển thị model chính đã được phân giải, các fallback, model hình ảnh và tổng quan xác thực của các provider đã cấu hình. Nó cũng hiển thị trạng thái hết hạn OAuth cho các hồ sơ tìm thấy trong kho xác thực (mặc định cảnh báo trong vòng 24h). `--plain` chỉ in ra model chính đã được phân giải.
Trạng thái OAuth luôn được hiển thị (và được bao gồm trong đầu ra `--json`). Nếu một provider đã cấu hình không có thông tin xác thực, `models status` sẽ in ra một mục **Missing auth**.
JSON bao gồm `auth.oauth` (cửa sổ cảnh báo + hồ sơ) và `auth.providers` (xác thực hiệu lực theo từng provider).
Sử dụng `--check` cho tự động hóa (thoát với mã `1` khi thiếu/hết hạn, `2` khi sắp hết hạn).

Xác thực Anthropic được ưu tiên là setup-token của Claude Code CLI (chạy ở đâu cũng được; nếu cần thì dán trên máy chủ gateway):

```bash
claude setup-token
openclaw models status
```

## Quét (các mô hình miễn phí của OpenRouter)

`openclaw models scan` kiểm tra **danh mục mô hình miễn phí** của OpenRouter và có thể
tùy chọn probe các mô hình để kiểm tra hỗ trợ tool và hình ảnh.

Các cờ chính:

- `--no-probe`: bỏ qua probe trực tiếp (chỉ metadata)
- `--min-params <b>`: kích thước tham số tối thiểu (tỷ)
- `--max-age-days <days>`: bỏ qua các mô hình cũ hơn
- `--provider <name>`: bộ lọc tiền tố nhà cung cấp
- `--max-candidates <n>`: kích thước danh sách fallback
- `--set-default`: đặt `agents.defaults.model.primary` thành lựa chọn đầu tiên
- `--set-image`: đặt `agents.defaults.imageModel.primary` thành lựa chọn hình ảnh đầu tiên

Việc probing yêu cầu khóa API OpenRouter (từ hồ sơ xác thực hoặc `OPENROUTER_API_KEY`). Nếu không có khóa, dùng `--no-probe` để chỉ liệt kê các ứng viên.

Kết quả quét được xếp hạng theo:

1. Hỗ trợ hình ảnh
2. Độ trễ của tool
3. Kích thước context
4. Số lượng tham số

Input

- Danh sách OpenRouter `/models` (lọc `:free`)
- Yêu cầu khóa API OpenRouter từ hồ sơ xác thực hoặc `OPENROUTER_API_KEY` (xem [/environment](/help/environment))
- Bộ lọc tùy chọn: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Điều khiển probe: `--timeout`, `--concurrency`

Khi chạy trong TTY, bạn có thể chọn các fallback một cách tương tác. Trong chế độ không tương tác, truyền `--yes` để chấp nhận các giá trị mặc định.

## Registry mô hình (`models.json`)

Các provider tùy chỉnh trong `models.providers` được ghi vào `models.json` dưới thư mục agent (mặc định `~/.openclaw/agents/<agentId>/models.json`). Tệp này được hợp nhất theo mặc định trừ khi `models.mode` được đặt thành `replace`.
