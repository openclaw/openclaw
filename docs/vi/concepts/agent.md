---
summary: "Runtime tác tử (pi-mono nhúng), hợp đồng workspace và khởi tạo phiên"
read_when:
  - Khi thay đổi runtime tác tử, khởi tạo workspace hoặc hành vi phiên
title: "Runtime tác tử"
x-i18n:
  source_path: concepts/agent.md
  source_hash: 121103fda29a5481
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:41Z
---

# Runtime tác tử 🤖

OpenClaw chạy một runtime tác tử nhúng duy nhất, bắt nguồn từ **pi-mono**.

## Workspace (bắt buộc)

OpenClaw sử dụng một thư mục workspace tác tử duy nhất (`agents.defaults.workspace`) làm thư mục làm việc **duy nhất** (`cwd`) của tác tử cho công cụ và ngữ cảnh.

Khuyến nghị: dùng `openclaw setup` để tạo `~/.openclaw/openclaw.json` nếu thiếu và khởi tạo các tệp workspace.

Bố cục workspace đầy đủ + hướng dẫn sao lưu: [Agent workspace](/concepts/agent-workspace)

Nếu `agents.defaults.sandbox` được bật, các phiên không phải chính có thể ghi đè bằng
workspace theo từng phiên dưới `agents.defaults.sandbox.workspaceRoot` (xem
[Cấu hình Gateway](/gateway/configuration)).

## Tệp bootstrap (được chèn)

Bên trong `agents.defaults.workspace`, OpenClaw mong đợi các tệp có thể chỉnh sửa bởi người dùng sau:

- `AGENTS.md` — hướng dẫn vận hành + “bộ nhớ”
- `SOUL.md` — persona, ranh giới, giọng điệu
- `TOOLS.md` — ghi chú công cụ do người dùng duy trì (ví dụ `imsg`, `sag`, quy ước)
- `BOOTSTRAP.md` — nghi thức chạy lần đầu một lần (bị xóa sau khi hoàn tất)
- `IDENTITY.md` — tên/vibe/emoji của tác tử
- `USER.md` — hồ sơ người dùng + cách xưng hô ưa thích

Ở lượt đầu của một phiên mới, OpenClaw chèn trực tiếp nội dung của các tệp này vào ngữ cảnh tác tử.

Các tệp trống sẽ bị bỏ qua. Tệp lớn được cắt bớt và rút gọn kèm một dấu đánh dấu để prompt gọn nhẹ (đọc tệp để xem đầy đủ nội dung).

Nếu một tệp bị thiếu, OpenClaw chèn một dòng đánh dấu “missing file” duy nhất (và `openclaw setup` sẽ tạo một mẫu mặc định an toàn).

`BOOTSTRAP.md` chỉ được tạo cho **workspace hoàn toàn mới** (không có tệp bootstrap nào khác). Nếu bạn xóa nó sau khi hoàn tất nghi thức, nó sẽ không được tạo lại ở các lần khởi động sau.

Để tắt hoàn toàn việc tạo tệp bootstrap (cho workspace đã được seed sẵn), đặt:

```json5
{ agent: { skipBootstrap: true } }
```

## Công cụ tích hợp sẵn

Các công cụ lõi (read/exec/edit/write và các công cụ hệ thống liên quan) luôn khả dụng,
tùy theo chính sách công cụ. `apply_patch` là tùy chọn và bị kiểm soát bởi
`tools.exec.applyPatch`. `TOOLS.md` **không** kiểm soát công cụ nào tồn tại; nó là
hướng dẫn cho cách _bạn_ muốn chúng được sử dụng.

## Skills

OpenClaw tải Skills từ ba vị trí (workspace thắng khi trùng tên):

- Bundled (đi kèm bản cài đặt)
- Managed/local: `~/.openclaw/skills`
- Workspace: `<workspace>/skills`

Skills có thể bị kiểm soát bởi config/env (xem `skills` trong [Cấu hình Gateway](/gateway/configuration)).

## Tích hợp pi-mono

OpenClaw tái sử dụng một số phần của codebase pi-mono (mô hình/công cụ), nhưng **quản lý phiên, khám phá và wiring công cụ thuộc OpenClaw**.

- Không có runtime tác tử pi-coding.
- Không tham chiếu các thiết lập `~/.pi/agent` hoặc `<workspace>/.pi`.

## Phiên

Bản ghi phiên được lưu dưới dạng JSONL tại:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

ID phiên là ổn định và do OpenClaw chọn.
Các thư mục phiên Pi/Tau cũ **không** được đọc.

## Điều hướng khi streaming

Khi chế độ hàng đợi là `steer`, các tin nhắn đến được chèn vào lượt chạy hiện tại.
Hàng đợi được kiểm tra **sau mỗi lần gọi công cụ**; nếu có tin nhắn đang chờ,
các lần gọi công cụ còn lại từ thông điệp trợ lý hiện tại sẽ bị bỏ qua (kết quả công cụ lỗi với "Skipped due to queued user message."), sau đó tin nhắn người dùng đang chờ
được chèn trước phản hồi trợ lý tiếp theo.

Khi chế độ hàng đợi là `followup` hoặc `collect`, các tin nhắn đến được giữ lại cho đến khi
lượt hiện tại kết thúc, rồi bắt đầu một lượt tác tử mới với các payload đang chờ. Xem
[Queue](/concepts/queue) để biết chế độ + hành vi debounce/cap.

Block streaming gửi các khối trợ lý đã hoàn tất ngay khi xong; nó **tắt theo mặc định** (`agents.defaults.blockStreamingDefault: "off"`).
Tinh chỉnh ranh giới qua `agents.defaults.blockStreamingBreak` (`text_end` so với `message_end`; mặc định là text_end).
Kiểm soát việc chia khối mềm bằng `agents.defaults.blockStreamingChunk` (mặc định
800–1200 ký tự; ưu tiên ngắt đoạn, sau đó là xuống dòng; câu là lựa chọn cuối).
Gộp các mảnh stream bằng `agents.defaults.blockStreamingCoalesce` để giảm
spam một dòng (gộp theo thời gian rảnh trước khi gửi). Các kênh không phải Telegram yêu cầu
`*.blockStreaming: true` rõ ràng để bật trả lời theo khối.
Tóm tắt công cụ chi tiết được phát tại lúc bắt đầu công cụ (không debounce); UI điều khiển
stream đầu ra công cụ qua các sự kiện tác tử khi có.
Chi tiết thêm: [Streaming + chunking](/concepts/streaming).

## Tham chiếu mô hình

Các tham chiếu mô hình trong config (ví dụ `agents.defaults.model` và `agents.defaults.models`) được phân tích bằng cách tách theo `/` **đầu tiên**.

- Dùng `provider/model` khi cấu hình mô hình.
- Nếu ID mô hình tự nó chứa `/` (kiểu OpenRouter), hãy bao gồm tiền tố nhà cung cấp (ví dụ: `openrouter/moonshotai/kimi-k2`).
- Nếu bạn bỏ qua nhà cung cấp, OpenClaw coi đầu vào là một alias hoặc một mô hình cho **nhà cung cấp mặc định** (chỉ hoạt động khi không có `/` trong ID mô hình).

## Cấu hình (tối thiểu)

Ít nhất, hãy đặt:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (khuyến nghị mạnh)

---

_Tiếp theo: [Group Chats](/channels/group-messages)_ 🦞
