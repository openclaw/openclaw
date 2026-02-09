---
summary: "Vòng đời agent loop, các luồng, và ngữ nghĩa chờ"
read_when:
  - Bạn cần bản hướng dẫn chi tiết từng bước về agent loop hoặc các sự kiện vòng đời
title: "Agent Loop"
---

# Agent Loop (OpenClaw)

Trong OpenClaw, một vòng lặp là một lần chạy đơn lẻ, được tuần tự hóa cho mỗi phiên, phát ra các sự kiện vòng đời và stream
khi mô hình suy nghĩ, gọi công cụ và stream đầu ra. It’s the authoritative path that turns a message
into actions and a final reply, while keeping session state consistent.

Tài liệu này giải thích cách vòng lặp xác thực đó
được nối dây đầu-cuối. trả về `{ status: ok|error|timeout, startedAt, endedAt, error?`

## Điểm vào

- RPC của Gateway: `agent` và `agent.wait`.
- CLI: lệnh `agent`.

## Cách hoạt động (mức cao)

1. RPC `agent` xác thực tham số, phân giải phiên (sessionKey/sessionId), lưu metadata phiên, trả về `{ runId, acceptedAt }` ngay lập tức.
2. `agentCommand` chạy tác tử:
   - phân giải mô hình + mặc định thinking/verbose
   - tải snapshot skills
   - gọi `runEmbeddedPiAgent` (runtime pi-agent-core)
   - phát **lifecycle end/error** nếu loop nhúng không phát ra
3. `runEmbeddedPiAgent`:
   - tuần tự hóa các lần chạy qua hàng đợi theo phiên + hàng đợi toàn cục
   - phân giải mô hình + hồ sơ xác thực và xây dựng phiên pi
   - đăng ký các sự kiện pi và stream delta của assistant/công cụ
   - áp dụng timeout -> hủy lần chạy nếu vượt quá
   - trả về payload + metadata usage
4. `subscribeEmbeddedPiSession` bắc cầu các sự kiện pi-agent-core sang stream `agent` của OpenClaw:
   - sự kiện công cụ => `stream: "tool"`
   - delta của assistant => `stream: "assistant"`
   - sự kiện vòng đời => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` dùng `waitForAgentJob`:
   - chờ **lifecycle end/error** cho `runId`
   - }\` Các kênh nhắn tin có thể chọn các chế độ hàng đợi (collect/steer/followup) để cấp dữ liệu cho hệ thống lane này.

## Xếp hàng + đồng thời

- Các lần chạy được tuần tự hóa theo từng khóa phiên (làn phiên) và tùy chọn qua một làn toàn cục.
- Điều này ngăn đua công cụ/phiên và giữ lịch sử phiên nhất quán.
- Xem [Command Queue](/concepts/queue).
  **`agent:bootstrap`**: chạy trong khi xây dựng các tệp bootstrap trước khi system prompt được hoàn tất.

## Chuẩn bị phiên + workspace

- Workspace được phân giải và tạo; các lần chạy sandboxed có thể chuyển hướng tới thư mục gốc workspace sandbox.
- Skills được tải (hoặc tái sử dụng từ snapshot) và chèn vào env và prompt.
- Các tệp bootstrap/ngữ cảnh được phân giải và chèn vào báo cáo system prompt.
- Một khóa ghi phiên được lấy; `SessionManager` được mở và chuẩn bị trước khi stream.

## Lắp ráp prompt + system prompt

- System prompt được xây từ prompt nền của OpenClaw, prompt skills, ngữ cảnh bootstrap và các ghi đè theo lần chạy.
- Áp dụng các giới hạn theo mô hình và dự trữ token cho compaction.
- Xem [System prompt](/concepts/system-prompt) để biết mô hình nhìn thấy gì.

## Điểm hook (nơi bạn có thể can thiệp)

OpenClaw có hai hệ hook:

- **Hook nội bộ** (hook của Gateway): script theo sự kiện cho lệnh và sự kiện vòng đời.
- **Hook plugin**: điểm mở rộng bên trong vòng đời agent/công cụ và pipeline gateway.

### Hook nội bộ (hook của Gateway)

- Mặc định `agent.wait`: 30s (chỉ thời gian chờ).
  Use this to add/remove bootstrap context files.
- **Hook lệnh**: `/new`, `/reset`, `/stop`, và các sự kiện lệnh khác (xem tài liệu Hooks).

Xem [Hooks](/automation/hooks) để biết thiết lập và ví dụ.

### Hook plugin (vòng đời agent + gateway)

Các hook này chạy bên trong agent loop hoặc pipeline gateway:

- **`before_agent_start`**: chèn ngữ cảnh hoặc ghi đè system prompt trước khi chạy.
- **`agent_end`**: kiểm tra danh sách thông điệp cuối cùng và metadata lần chạy sau khi hoàn tất.
- **`before_compaction` / `after_compaction`**: quan sát hoặc chú thích các chu kỳ compaction.
- **`before_tool_call` / `after_tool_call`**: chặn tham số/kết quả công cụ.
- **`tool_result_persist`**: biến đổi đồng bộ kết quả công cụ trước khi được ghi vào bản ghi phiên.
- **`message_received` / `message_sending` / `message_sent`**: hook thông điệp vào + ra.
- **`session_start` / `session_end`**: ranh giới vòng đời phiên.
- **`gateway_start` / `gateway_stop`**: sự kiện vòng đời gateway.

Xem [Plugins](/tools/plugin#plugin-hooks) để biết API hook và chi tiết đăng ký.

## Streaming + phản hồi từng phần

- Delta của assistant được stream từ pi-agent-core và phát dưới dạng sự kiện `assistant`.
- Block streaming có thể phát phản hồi từng phần trên `text_end` hoặc `message_end`.
- Streaming lập luận có thể phát thành một stream riêng hoặc dưới dạng block replies.
- Xem [Streaming](/concepts/streaming) để biết hành vi chia khối và block reply.

## Thực thi công cụ + công cụ nhắn tin

- Sự kiện bắt đầu/cập nhật/kết thúc công cụ được phát trên stream `tool`.
- Kết quả công cụ được làm sạch về kích thước và payload hình ảnh trước khi ghi log/phát.
- Các lần gửi của công cụ nhắn tin được theo dõi để tránh xác nhận trùng lặp từ assistant.

## Định hình phản hồi + loại bỏ

- Payload cuối cùng được lắp ráp từ:
  - văn bản assistant (và lập luận tùy chọn)
  - tóm tắt công cụ inline (khi verbose + được phép)
  - văn bản lỗi của assistant khi mô hình lỗi
- `NO_REPLY` được coi là token im lặng và bị lọc khỏi payload gửi đi.
- Các bản sao trùng lặp từ công cụ nhắn tin được loại khỏi danh sách payload cuối.
- Nếu không còn payload có thể hiển thị và một công cụ bị lỗi, một phản hồi lỗi dự phòng của công cụ sẽ được phát
  (trừ khi công cụ nhắn tin đã gửi phản hồi hiển thị cho người dùng).

## Compaction + thử lại

- Auto-compaction phát các sự kiện stream `compaction` và có thể kích hoạt thử lại.
- Khi thử lại, các bộ đệm trong bộ nhớ và tóm tắt công cụ được đặt lại để tránh đầu ra trùng lặp.
- Xem [Compaction](/concepts/compaction) để biết pipeline compaction.

## Các stream sự kiện (hiện tại)

- `lifecycle`: phát bởi `subscribeEmbeddedPiSession` (và dự phòng bởi `agentCommand`)
- `assistant`: delta được stream từ pi-agent-core
- `tool`: sự kiện công cụ được stream từ pi-agent-core

## Xử lý kênh chat

- Delta của assistant được đệm thành các thông điệp chat `delta`.
- Một chat `final` được phát khi **lifecycle end/error**.

## Timeout

- Tham số `timeoutMs` ghi đè. Workspace là ngôi nhà của agent.
- Runtime của agent: mặc định `agents.defaults.timeoutSeconds` 600s; được áp dụng trong bộ hẹn giờ hủy `runEmbeddedPiAgent`.

## Những nơi có thể kết thúc sớm

- Hết thời gian agent (abort)
- AbortSignal (hủy)
- Gateway ngắt kết nối hoặc RPC timeout
- Timeout `agent.wait` (chỉ chờ, không dừng agent)
