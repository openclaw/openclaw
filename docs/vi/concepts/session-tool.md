---
summary: "Công cụ phiên tác tử để liệt kê phiên, lấy lịch sử và gửi tin nhắn giữa các phiên"
read_when:
  - Thêm hoặc chỉnh sửa công cụ phiên
title: "Công cụ Phiên"
---

# Công cụ Phiên

Mục tiêu: bộ công cụ nhỏ, khó dùng sai để tác tử có thể liệt kê phiên, lấy lịch sử và gửi sang một phiên khác.

## Tên Công Cụ

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Mô Hình Khóa

- Bucket chat trực tiếp chính luôn là khóa literal `"main"` (được phân giải thành khóa chính của tác tử hiện tại).
- Chat nhóm dùng `agent:<agentId>:<channel>:group:<id>` hoặc `agent:<agentId>:<channel>:channel:<id>` (truyền đầy đủ khóa).
- Cron jobs dùng `cron:<job.id>`.
- Hooks dùng `hook:<uuid>` trừ khi được đặt rõ ràng.
- Phiên node dùng `node-<nodeId>` trừ khi được đặt rõ ràng.

41. `global` và `unknown` là các giá trị được dành riêng và không bao giờ được liệt kê. 42. Nếu `session.scope = "global"`, chúng tôi ánh xạ nó thành `main` cho tất cả công cụ để người gọi không bao giờ thấy `global`.

## sessions_list

Liệt kê các phiên dưới dạng mảng các hàng.

Tham số:

- `kinds?: string[]` bộ lọc: một trong các `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` số hàng tối đa (mặc định: theo mặc định của server, kẹp ví dụ 200)
- `activeMinutes?: number` chỉ các phiên được cập nhật trong vòng N phút
- `messageLimit?: number` 0 = không có tin nhắn (mặc định 0); >0 = bao gồm N tin nhắn cuối

Hành vi:

- `messageLimit > 0` lấy `chat.history` cho mỗi phiên và bao gồm N tin nhắn cuối.
- Kết quả công cụ được lọc khỏi đầu ra danh sách; dùng `sessions_history` cho tin nhắn công cụ.
- Khi chạy trong một phiên tác tử **sandboxed**, các công cụ phiên mặc định chỉ có **khả năng hiển thị các phiên được spawn** (xem bên dưới).

Dạng hàng (JSON):

- `key`: khóa phiên (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (nhãn hiển thị nhóm nếu có)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (ghi đè phiên nếu được đặt)
- `lastChannel`, `lastTo`
- `deliveryContext` (`{ channel, to, accountId }` đã được chuẩn hóa khi có)
- `transcriptPath` (đường dẫn best-effort suy ra từ thư mục lưu trữ + sessionId)
- `messages?` (chỉ khi `messageLimit > 0`)

## sessions_history

Lấy bản ghi hội thoại cho một phiên.

Tham số:

- `sessionKey` (bắt buộc; chấp nhận khóa phiên hoặc `sessionId` từ `sessions_list`)
- `limit?: number` số tin nhắn tối đa (server sẽ kẹp)
- `includeTools?: boolean` (mặc định false)

Hành vi:

- `includeTools=false` lọc các tin nhắn `role: "toolResult"`.
- Trả về mảng tin nhắn theo định dạng transcript thô.
- Khi cung cấp `sessionId`, OpenClaw sẽ phân giải nó thành khóa phiên tương ứng (lỗi nếu thiếu id).

## sessions_send

Gửi một tin nhắn vào một phiên khác.

Tham số:

- `sessionKey` (bắt buộc; chấp nhận khóa phiên hoặc `sessionId` từ `sessions_list`)
- `message` (bắt buộc)
- `timeoutSeconds?: number` (mặc định >0; 0 = fire-and-forget)

Hành vi:

- `timeoutSeconds = 0`: xếp hàng và trả về `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: chờ tối đa N giây để hoàn tất, sau đó trả về `{ runId, status: "ok", reply }`.
- 43. Nếu chờ bị hết thời gian: `{ runId, status: "timeout", error }`. 44. Lần chạy vẫn tiếp tục; hãy gọi `sessions_history` sau.
- Nếu tiến trình thất bại: `{ runId, status: "error", error }`.
- Các lần chạy thông báo (announce) sau khi lần chạy chính hoàn tất và là best-effort; `status: "ok"` không đảm bảo thông báo đã được gửi.
- Chờ thông qua `agent.wait` của gateway (phía server) để việc reconnect không làm rơi quá trình chờ.
- Ngữ cảnh tin nhắn tác tử‑tác tử được chèn cho lần chạy chính.
- Sau khi lần chạy chính hoàn tất, OpenClaw chạy **vòng lặp reply-back**:
  - Vòng 2+ luân phiên giữa tác tử yêu cầu và tác tử đích.
  - Trả lời chính xác `REPLY_SKIP` để dừng ping‑pong.
  - Số lượt tối đa là `session.agentToAgent.maxPingPongTurns` (0–5, mặc định 5).
- Khi vòng lặp kết thúc, OpenClaw chạy **bước announce tác tử‑tác tử** (chỉ tác tử đích):
  - Trả lời chính xác `ANNOUNCE_SKIP` để giữ im lặng.
  - Bất kỳ phản hồi nào khác sẽ được gửi tới kênh đích.
  - Bước announce bao gồm yêu cầu ban đầu + phản hồi vòng 1 + phản hồi ping‑pong mới nhất.

## Trường Channel

- Với nhóm, `channel` là kênh được ghi trên mục phiên.
- Với chat trực tiếp, `channel` ánh xạ từ `lastChannel`.
- Với cron/hook/node, `channel` là `internal`.
- Nếu thiếu, `channel` là `unknown`.

## Bảo Mật / Chính Sách Gửi

Chặn theo chính sách dựa trên kênh/loại chat (không theo session id).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Ghi đè runtime (theo từng mục phiên):

- `sendPolicy: "allow" | "deny"` (không đặt = kế thừa cấu hình)
- Có thể đặt qua `sessions.patch` hoặc `/send on|off|inherit` chỉ cho owner (tin nhắn độc lập).

Điểm thực thi:

- `chat.send` / `agent` (gateway)
- logic phân phối auto-reply

## sessions_spawn

Spawn một lần chạy sub-agent trong một phiên cô lập và thông báo kết quả trở lại kênh chat của người yêu cầu.

Tham số:

- `task` (bắt buộc)
- `label?` (tùy chọn; dùng cho logs/UI)
- `agentId?` (tùy chọn; spawn dưới một agent id khác nếu được phép)
- `model?` (tùy chọn; ghi đè mô hình sub-agent; giá trị không hợp lệ sẽ lỗi)
- `runTimeoutSeconds?` (mặc định 0; khi đặt, hủy lần chạy sub-agent sau N giây)
- `cleanup?` (`delete|keep`, mặc định `keep`)

Danh sách cho phép:

- 45. `agents.list[].subagents.allowAgents`: danh sách id agent được phép qua `agentId` (`["*"]` để cho phép bất kỳ). 46. Mặc định: chỉ agent yêu cầu.

Khám phá:

- Dùng `agents_list` để khám phá các agent id nào được phép cho `sessions_spawn`.

Hành vi:

- Bắt đầu một phiên `agent:<agentId>:subagent:<uuid>` mới với `deliver: false`.
- Sub-agent mặc định có đầy đủ bộ công cụ **trừ các công cụ phiên** (có thể cấu hình qua `tools.subagents.tools`).
- Sub-agent không được phép gọi `sessions_spawn` (không spawn sub-agent → sub-agent).
- Luôn không chặn: trả về `{ status: "accepted", runId, childSessionKey }` ngay lập tức.
- Sau khi hoàn tất, OpenClaw chạy **bước announce sub-agent** và đăng kết quả lên kênh chat của người yêu cầu.
- Trả lời chính xác `ANNOUNCE_SKIP` trong bước announce để giữ im lặng.
- Phản hồi announce được chuẩn hóa thành `Status`/`Result`/`Notes`; `Status` đến từ kết quả runtime (không phải văn bản của mô hình).
- Các phiên sub-agent được tự động lưu trữ sau `agents.defaults.subagents.archiveAfterMinutes` (mặc định: 60).
- Phản hồi announce bao gồm một dòng thống kê (thời gian chạy, tokens, sessionKey/sessionId, đường dẫn transcript và chi phí tùy chọn).

## Khả Năng Hiển Thị Phiên Sandbox

Các phiên sandboxed có thể dùng công cụ phiên, nhưng mặc định chỉ thấy các phiên mà chúng spawn thông qua `sessions_spawn`.

Cấu hình:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
