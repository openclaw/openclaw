---
summary: "Backend CLI: phương án dự phòng chỉ văn bản qua các CLI AI cục bộ"
read_when:
  - Bạn muốn một phương án dự phòng đáng tin cậy khi các nhà cung cấp API gặp sự cố
  - Bạn đang chạy Claude Code CLI hoặc các CLI AI cục bộ khác và muốn tái sử dụng chúng
  - Bạn cần một luồng chỉ văn bản, không dùng công cụ nhưng vẫn hỗ trợ phiên và hình ảnh
title: "Backend CLI"
---

# Backend CLI (runtime dự phòng)

OpenClaw can run **local AI CLIs** as a **text-only fallback** when API providers are down,
rate-limited, or temporarily misbehaving. This is intentionally conservative:

- **Tắt công cụ** (không gọi công cụ).
- **Văn bản vào → văn bản ra** (đáng tin cậy).
- **Hỗ trợ phiên** (để các lượt tiếp theo giữ được mạch lạc).
- **Có thể truyền hình ảnh** nếu CLI chấp nhận đường dẫn ảnh.

This is designed as a **safety net** rather than a primary path. Dùng nó khi bạn
muốn phản hồi văn bản “luôn hoạt động” mà không phụ thuộc vào API bên ngoài.

## Khởi động nhanh cho người mới

Bạn có thể dùng Claude Code CLI **không cần cấu hình nào** (OpenClaw đi kèm mặc định sẵn):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI cũng hoạt động ngay:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Nếu gateway của bạn chạy dưới launchd/systemd và PATH bị tối giản, chỉ cần thêm
đường dẫn lệnh:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

Vậy là xong. No keys, no extra auth config needed beyond the CLI itself.

## Dùng như phương án dự phòng

Thêm một backend CLI vào danh sách fallback để nó chỉ chạy khi các mô hình chính thất bại:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

Ghi chú:

- Nếu bạn dùng `agents.defaults.models` (allowlist), bạn phải bao gồm `claude-cli/...`.
- Nếu nhà cung cấp chính thất bại (xác thực, giới hạn tốc độ, timeout), OpenClaw sẽ
  thử backend CLI tiếp theo.

## Tổng quan cấu hình

Tất cả backend CLI nằm dưới:

```
agents.defaults.cliBackends
```

Each entry is keyed by a **provider id** (e.g. `claude-cli`, `my-cli`).
The provider id becomes the left side of your model ref:

```
<provider>/<model>
```

### Ví dụ cấu hình

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## Cách hoạt động

1. **Chọn backend** dựa trên tiền tố provider (`claude-cli/...`).
2. **Xây dựng system prompt** bằng cùng prompt OpenClaw + ngữ cảnh workspace.
3. **Thực thi CLI** với id phiên (nếu được hỗ trợ) để lịch sử nhất quán.
4. **Phân tích đầu ra** (JSON hoặc văn bản thuần) và trả về văn bản cuối.
5. **Lưu trữ id phiên** theo từng backend, để các lượt tiếp theo tái sử dụng cùng phiên CLI.

## Phiên (Sessions)

- Nếu CLI hỗ trợ phiên, đặt `sessionArg` (ví dụ: `--session-id`) hoặc
  `sessionArgs` (placeholder `{sessionId}`) khi id cần được chèn vào nhiều cờ.
- Nếu CLI dùng **lệnh con resume** với các cờ khác, đặt
  `resumeArgs` (thay thế `args` khi resume) và tùy chọn `resumeOutput`
  (cho resume không phải JSON).
- `sessionMode`:
  - `always`: luôn gửi id phiên (UUID mới nếu chưa lưu).
  - `existing`: chỉ gửi id phiên nếu đã lưu trước đó.
  - `none`: không bao giờ gửi id phiên.

## Hình ảnh (truyền thẳng)

Nếu CLI của bạn chấp nhận đường dẫn ảnh, đặt `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw will write base64 images to temp files. If `imageArg` is set, those
paths are passed as CLI args. Nếu thiếu `imageArg`, OpenClaw sẽ nối thêm
các đường dẫn tệp vào prompt (path injection), điều này đủ cho các CLI tự động
nạp tệp cục bộ từ đường dẫn thuần (hành vi của Claude Code CLI).

## Đầu vào / đầu ra

- `output: "json"` (mặc định) cố gắng phân tích JSON và trích xuất văn bản + id phiên.
- `output: "jsonl"` phân tích luồng JSONL (Codex CLI `--json`) và trích xuất
  thông điệp tác tử cuối cùng cùng `thread_id` khi có.
- `output: "text"` coi stdout là phản hồi cuối cùng.

Chế độ đầu vào:

- `input: "arg"` (mặc định) truyền prompt như đối số CLI cuối.
- `input: "stdin"` gửi prompt qua stdin.
- Nếu prompt rất dài và `maxPromptArgChars` được đặt, sẽ dùng stdin.

## Mặc định (tích hợp sẵn)

OpenClaw đi kèm mặc định cho `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw cũng đi kèm mặc định cho `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Chỉ ghi đè khi cần (thường gặp: đường dẫn `command` tuyệt đối).

## Hạn chế

- **Không có công cụ OpenClaw** (backend CLI không bao giờ nhận các lời gọi công cụ). Some CLIs
  may still run their own agent tooling.
- **Không streaming** (đầu ra CLI được thu thập rồi mới trả về).
- **Đầu ra có cấu trúc** phụ thuộc vào định dạng JSON của CLI.
- **Các phiên Codex CLI** được tiếp tục thông qua đầu ra văn bản (không có JSONL), kém
  có cấu trúc hơn so với lần chạy `--json` ban đầu. OpenClaw sessions still work
  normally.

## Xử lý sự cố

- **Không tìm thấy CLI**: đặt `command` thành đường dẫn đầy đủ.
- **Sai tên mô hình**: dùng `modelAliases` để ánh xạ `provider/model` → mô hình CLI.
- **Không duy trì được phiên**: đảm bảo `sessionArg` được đặt và `sessionMode` không phải
  `none` (Codex CLI hiện không thể resume với đầu ra JSON).
- **Hình ảnh bị bỏ qua**: đặt `imageArg` (và xác minh CLI hỗ trợ đường dẫn tệp).
