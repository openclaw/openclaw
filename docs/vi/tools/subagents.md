---
summary: "Sub-agent: tạo các lần chạy tác tử cô lập chạy song song và thông báo kết quả về chat yêu cầu"
read_when:
  - Bạn muốn thực hiện công việc nền/song song thông qua tác tử
  - Bạn đang thay đổi sessions_spawn hoặc chính sách công cụ sub-agent
title: "Sub-Agents"
---

# Sub-agents

Sub-agents are background agent runs spawned from an existing agent run. They run in their own session (`agent:<agentId>:subagent:<uuid>`) and, when finished, **announce** their result back to the requester chat channel.

## Lệnh slash

Dùng `/subagents` để kiểm tra hoặc điều khiển các lần chạy sub-agent cho **phiên hiện tại**:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` hiển thị metadata của lần chạy (trạng thái, mốc thời gian, id phiên, đường dẫn transcript, dọn dẹp).

Mục tiêu chính:

- Song song hóa công việc “nghiên cứu / tác vụ dài / công cụ chậm” mà không chặn lần chạy chính.
- Giữ sub-agent cô lập theo mặc định (tách phiên + sandboxing tùy chọn).
- Giữ bề mặt công cụ khó bị dùng sai: sub-agent **không** có công cụ của phiên theo mặc định.
- Tránh fan-out lồng nhau: sub-agent không thể tạo sub-agent khác.

Cost note: each sub-agent has its **own** context and token usage. For heavy or repetitive
tasks, set a cheaper model for sub-agents and keep your main agent on a higher-quality model.
You can configure this via `agents.defaults.subagents.model` or per-agent overrides.

## Công cụ

Dùng `sessions_spawn`:

- Bắt đầu một lần chạy sub-agent (`deliver: false`, làn toàn cục: `subagent`)
- Sau đó chạy bước announce và đăng phản hồi announce lên kênh chat của bên yêu cầu
- Mô hình mặc định: kế thừa từ bên gọi trừ khi bạn đặt `agents.defaults.subagents.model` (hoặc theo từng tác tử `agents.list[].subagents.model`); `sessions_spawn.model` được đặt tường minh vẫn được ưu tiên.
- Mức thinking mặc định: kế thừa từ bên gọi trừ khi bạn đặt `agents.defaults.subagents.thinking` (hoặc theo từng tác tử `agents.list[].subagents.thinking`); `sessions_spawn.thinking` được đặt tường minh vẫn được ưu tiên.

Tham số công cụ:

- `task` (bắt buộc)
- `label?` (tùy chọn)
- `agentId?` (tùy chọn; tạo dưới một agent id khác nếu được phép)
- `model?` (tùy chọn; ghi đè mô hình của sub-agent; giá trị không hợp lệ sẽ bị bỏ qua và sub-agent chạy bằng mô hình mặc định kèm cảnh báo trong kết quả công cụ)
- `thinking?` (tùy chọn; ghi đè mức thinking cho lần chạy sub-agent)
- `runTimeoutSeconds?` (mặc định `0`; khi đặt, lần chạy sub-agent sẽ bị hủy sau N giây)
- `cleanup?` (`delete|keep`, mặc định `keep`)

Danh sách cho phép:

- `agents.list[].subagents.allowAgents`: list of agent ids that can be targeted via `agentId` (`["*"]` to allow any). Default: only the requester agent.

Khám phá:

- Dùng `agents_list` để xem agent id nào hiện được phép cho `sessions_spawn`.

Tự động lưu trữ:

- Phiên sub-agent được tự động lưu trữ sau `agents.defaults.subagents.archiveAfterMinutes` (mặc định: 60).
- Archive uses `sessions.delete` and renames the transcript to `*.deleted.<timestamp>` (same folder).
- `cleanup: "delete"` lưu trữ ngay sau announce (vẫn giữ transcript thông qua đổi tên).
- Tự động lưu trữ là best-effort; các bộ hẹn giờ đang chờ sẽ bị mất nếu gateway khởi động lại.
- `runTimeoutSeconds` does **not** auto-archive; it only stops the run. The session remains until auto-archive.

## Xác thực

Xác thực sub-agent được phân giải theo **agent id**, không theo loại phiên:

- Khóa phiên của sub-agent là `agent:<agentId>:subagent:<uuid>`.
- Kho xác thực được tải từ `agentDir` của tác tử đó.
- Hồ sơ xác thực của tác tử chính được gộp vào như một **dự phòng**; hồ sơ của tác tử ghi đè hồ sơ chính khi xung đột.

Note: the merge is additive, so main profiles are always available as fallbacks. Fully isolated auth per agent is not supported yet.

## Announce

Sub-agent báo cáo kết quả thông qua bước announce:

- Bước announce chạy bên trong phiên sub-agent (không phải phiên của bên yêu cầu).
- Nếu sub-agent trả lời chính xác `ANNOUNCE_SKIP`, sẽ không có gì được đăng.
- Ngược lại, phản hồi announce sẽ được đăng lên kênh chat của bên yêu cầu qua một lệnh `agent` tiếp theo (`deliver=true`).
- Phản hồi announce giữ nguyên định tuyến luồng/chủ đề khi có (Slack threads, Telegram topics, Matrix threads).
- Thông điệp announce được chuẩn hóa theo một mẫu ổn định:
  - `Status:` được suy ra từ kết quả lần chạy (`success`, `error`, `timeout` hoặc `unknown`).
  - `Result:` là nội dung tóm tắt từ bước announce (hoặc `(not available)` nếu thiếu).
  - `Notes:` là chi tiết lỗi và các ngữ cảnh hữu ích khác.
- `Status` không được suy luận từ đầu ra mô hình; nó đến từ các tín hiệu kết quả khi chạy.

Payload announce bao gồm một dòng thống kê ở cuối (kể cả khi được bọc):

- Thời gian chạy (ví dụ: `runtime 5m12s`)
- Mức sử dụng token (đầu vào/đầu ra/tổng)
- Ước tính chi phí khi đã cấu hình giá mô hình (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId` và đường dẫn transcript (để tác tử chính có thể lấy lịch sử qua `sessions_history` hoặc kiểm tra tệp trên đĩa)

## Chính sách công cụ (công cụ của sub-agent)

Theo mặc định, sub-agent có **tất cả công cụ trừ công cụ của phiên**:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Ghi đè qua cấu hình:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Đồng thời

Sub-agent sử dụng một làn hàng đợi riêng trong tiến trình:

- Tên làn: `subagent`
- Độ đồng thời: `agents.defaults.subagents.maxConcurrent` (mặc định `8`)

## Dừng

- Gửi `/stop` trong chat của bên yêu cầu sẽ hủy phiên yêu cầu và dừng mọi lần chạy sub-agent đang hoạt động được tạo từ đó.

## Hạn chế

- Sub-agent announce is **best-effort**. If the gateway restarts, pending “announce back” work is lost.
- Sub-agent vẫn chia sẻ tài nguyên tiến trình gateway; hãy xem `maxConcurrent` như một van an toàn.
- `sessions_spawn` luôn không chặn: nó trả về `{ status: "accepted", runId, childSessionKey }` ngay lập tức.
- Ngữ cảnh sub-agent chỉ tiêm `AGENTS.md` + `TOOLS.md` (không có `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` hoặc `BOOTSTRAP.md`).
