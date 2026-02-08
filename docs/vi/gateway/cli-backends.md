---
summary: "Backend CLI: phương án dự phòng chỉ văn bản qua các CLI AI cục bộ"
read_when:
  - Bạn muốn một phương án dự phòng đáng tin cậy khi các nhà cung cấp API gặp sự cố
  - Bạn đang chạy Claude Code CLI hoặc các CLI AI cục bộ khác và muốn tái sử dụng chúng
  - Bạn cần một luồng chỉ văn bản, không dùng công cụ nhưng vẫn hỗ trợ phiên và hình ảnh
title: "Backend CLI"
x-i18n:
  source_path: gateway/cli-backends.md
  source_hash: 8285f4829900bc81
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:00Z
---

# Backend CLI (runtime dự phòng)

OpenClaw có thể chạy **các CLI AI cục bộ** như một **phương án dự phòng chỉ văn bản** khi các nhà cung cấp API bị gián đoạn,
bị giới hạn tốc độ hoặc tạm thời hoạt động không ổn định. Cách này được thiết kế có chủ đích là bảo thủ:

- **Tắt công cụ** (không gọi công cụ).
- **Văn bản vào → văn bản ra** (đáng tin cậy).
- **Hỗ trợ phiên** (để các lượt tiếp theo giữ được mạch lạc).
- **Có thể truyền hình ảnh** nếu CLI chấp nhận đường dẫn ảnh.

Đây là một **lưới an toàn** hơn là luồng chính. Hãy dùng khi bạn
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

Xong. Không cần khóa, không cần cấu hình xác thực bổ sung ngoài chính CLI.

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

Mỗi mục được khóa theo **provider id** (ví dụ: `claude-cli`, `my-cli`).
Provider id trở thành vế trái của tham chiếu mô hình:

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

OpenClaw sẽ ghi ảnh base64 ra các tệp tạm. Nếu `imageArg` được đặt, các
đường dẫn đó sẽ được truyền như đối số CLI. Nếu thiếu `imageArg`, OpenClaw
sẽ nối các đường dẫn tệp vào prompt (path injection), đủ cho các CLI tự động
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

- **Không có công cụ OpenClaw** (backend CLI không bao giờ nhận gọi công cụ). Một số CLI
  vẫn có thể chạy công cụ tác tử riêng của chúng.
- **Không streaming** (đầu ra CLI được thu thập rồi mới trả về).
- **Đầu ra có cấu trúc** phụ thuộc vào định dạng JSON của CLI.
- **Phiên Codex CLI** resume qua đầu ra văn bản (không phải JSONL), kém
  cấu trúc hơn so với lần chạy `--json` ban đầu. Các phiên OpenClaw
  vẫn hoạt động bình thường.

## Xử lý sự cố

- **Không tìm thấy CLI**: đặt `command` thành đường dẫn đầy đủ.
- **Sai tên mô hình**: dùng `modelAliases` để ánh xạ `provider/model` → mô hình CLI.
- **Không duy trì được phiên**: đảm bảo `sessionArg` được đặt và `sessionMode` không phải
  `none` (Codex CLI hiện không thể resume với đầu ra JSON).
- **Hình ảnh bị bỏ qua**: đặt `imageArg` (và xác minh CLI hỗ trợ đường dẫn tệp).
