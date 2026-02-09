---
summary: "Quy tắc quản lý phiên, khóa và tính bền vững cho các cuộc trò chuyện"
read_when:
  - Sửa đổi cách xử lý hoặc lưu trữ phiên
title: "Quản lý phiên"
---

# Quản lý phiên

47. OpenClaw coi **một phiên chat trực tiếp cho mỗi agent** là chính. 48. Chat trực tiếp được gộp thành `agent:<agentId>:<mainKey>` (mặc định `main`), trong khi chat nhóm/kênh có khóa riêng. 49. `session.mainKey` được tôn trọng.

Dùng `session.dmScope` để kiểm soát cách **tin nhắn trực tiếp (DM)** được nhóm lại:

- `main` (mặc định): tất cả DM chia sẻ phiên chính để đảm bảo tính liên tục.
- `per-peer`: tách theo id người gửi trên các kênh.
- `per-channel-peer`: tách theo kênh + người gửi (khuyến nghị cho hộp thư nhiều người dùng).
- 50. `per-account-channel-peer`: cô lập theo tài khoản + kênh + người gửi (khuyến nghị cho hộp thư đến đa tài khoản).
      Use `session.identityLinks` to map provider-prefixed peer ids to a canonical identity so the same person shares a DM session across channels when using `per-peer`, `per-channel-peer`, or `per-account-channel-peer`.

## Chế độ DM an toàn (khuyến nghị cho thiết lập nhiều người dùng)

> **Security Warning:** If your agent can receive DMs from **multiple people**, you should strongly consider enabling secure DM mode. Without it, all users share the same conversation context, which can leak private information between users.

**Ví dụ về vấn đề với thiết lập mặc định:**

- Alice (`<SENDER_A>`) nhắn cho tác tử của bạn về một chủ đề riêng tư (ví dụ: một cuộc hẹn y tế)
- Bob (`<SENDER_B>`) nhắn cho tác tử hỏi “Chúng ta đang nói về điều gì vậy?”
- Vì cả hai DM dùng chung một phiên, mô hình có thể trả lời Bob dựa trên ngữ cảnh trước đó của Alice.

**Cách khắc phục:** Đặt `dmScope` để tách phiên theo từng người dùng:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**Khi nào nên bật:**

- Bạn có phê duyệt ghép cặp cho nhiều hơn một người gửi
- Bạn dùng danh sách cho phép DM với nhiều mục
- Bạn đặt `dmPolicy: "open"`
- Nhiều số điện thoại hoặc tài khoản có thể nhắn cho tác tử của bạn

Ghi chú:

- Mặc định là `dmScope: "main"` để đảm bảo tính liên tục (tất cả DM dùng chung phiên chính). This is fine for single-user setups.
- Với hộp thư nhiều tài khoản trên cùng một kênh, ưu tiên `per-account-channel-peer`.
- Nếu cùng một người liên hệ bạn trên nhiều kênh, dùng `session.identityLinks` để gộp các phiên DM của họ thành một danh tính chuẩn.
- Bạn có thể kiểm tra thiết lập DM bằng `openclaw security audit` (xem [security](/cli/security)).

## Gateway là nguồn sự thật

All session state is **owned by the gateway** (the “master” OpenClaw). UI clients (macOS app, WebChat, etc.) must query the gateway for session lists and token counts instead of reading local files.

- Ở **chế độ từ xa**, kho phiên mà bạn quan tâm nằm trên máy chủ gateway từ xa, không phải trên máy Mac của bạn.
- Token counts shown in UIs come from the gateway’s store fields (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Clients do not parse JSONL transcripts to “fix up” totals.

## Trạng thái được lưu ở đâu

- Trên **máy chủ gateway**:
  - Tệp lưu trữ: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (theo từng tác tử).
- Transcript: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (phiên chủ đề Telegram dùng `.../<SessionId>-topic-<threadId>.jsonl`).
- Store là một map `sessionKey -> { sessionId, updatedAt, ...` }\`. Xóa các mục là an toàn; chúng sẽ được tạo lại khi cần.
- Các mục nhóm có thể bao gồm `displayName`, `channel`, `subject`, `room` và `space` để gắn nhãn phiên trong UI.
- Mục phiên bao gồm metadata `origin` (nhãn + gợi ý định tuyến) để UI có thể giải thích nguồn gốc phiên.
- OpenClaw **không** đọc các thư mục phiên Pi/Tau cũ.

## Cắt tỉa phiên

OpenClaw trims **old tool results** from the in-memory context right before LLM calls by default.
This does **not** rewrite JSONL history. Xem [/concepts/session-pruning](/concepts/session-pruning).

## Xả bộ nhớ trước khi nén

When a session nears auto-compaction, OpenClaw can run a **silent memory flush**
turn that reminds the model to write durable notes to disk. This only runs when
the workspace is writable. See [Memory](/concepts/memory) and
[Compaction](/concepts/compaction).

## Ánh xạ transport → khóa phiên

- Chat trực tiếp tuân theo `session.dmScope` (mặc định `main`).
  - `main`: `agent:<agentId>:<mainKey>` (liên tục giữa các thiết bị/kênh).
    - Nhiều số điện thoại và kênh có thể ánh xạ tới cùng khóa chính của tác tử; chúng hoạt động như các transport vào một cuộc hội thoại.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId mặc định là `default`).
  - Nếu `session.identityLinks` khớp với một peer id có tiền tố nhà cung cấp (ví dụ `telegram:123`), khóa chuẩn sẽ thay thế `<peerId>` để cùng một người chia sẻ phiên trên nhiều kênh.
- Chat nhóm tách biệt trạng thái: `agent:<agentId>:<channel>:group:<id>` (phòng/kênh dùng `agent:<agentId>:<channel>:channel:<id>`).
  - Chủ đề diễn đàn Telegram nối thêm `:topic:<threadId>` vào id nhóm để tách biệt.
  - Các khóa `group:<id>` cũ vẫn được nhận diện để phục vụ di chuyển.
- Ngữ cảnh vào có thể vẫn dùng `group:<id>`; kênh được suy ra từ `Provider` và chuẩn hóa về dạng chuẩn `agent:<agentId>:<channel>:group:<id>`.
- Các nguồn khác:
  - Cron job: `cron:<job.id>`
  - Webhook: `hook:<uuid>` (trừ khi được hook đặt rõ ràng)
  - Chạy node: `node-<nodeId>`

## Vòng đời

- Chính sách đặt lại: phiên được tái sử dụng cho đến khi hết hạn, và việc hết hạn được đánh giá ở tin nhắn vào tiếp theo.
- Daily reset: defaults to **4:00 AM local time on the gateway host**. A session is stale once its last update is earlier than the most recent daily reset time.
- Đặt lại khi nhàn rỗi (tùy chọn): `idleMinutes` thêm một cửa sổ nhàn rỗi trượt. Khi cả đặt lại theo ngày và theo nhàn rỗi đều được cấu hình, **cái nào hết hạn trước** sẽ buộc tạo phiên mới.
- Chỉ nhàn rỗi (cũ): nếu bạn đặt `session.idleMinutes` mà không có bất kỳ cấu hình `session.reset`/`resetByType` nào, OpenClaw sẽ ở chế độ chỉ nhàn rỗi để tương thích ngược.
- Ghi đè theo loại (tùy chọn): `resetByType` cho phép ghi đè chính sách cho các phiên `dm`, `group` và `thread` (thread = thread Slack/Discord, chủ đề Telegram, thread Matrix khi connector cung cấp).
- Ghi đè theo kênh (tùy chọn): `resetByChannel` ghi đè chính sách đặt lại cho một kênh (áp dụng cho mọi loại phiên của kênh đó và ưu tiên hơn `reset`/`resetByType`).
- Reset triggers: exact `/new` or `/reset` (plus any extras in `resetTriggers`) start a fresh session id and pass the remainder of the message through. `/new <model>` accepts a model alias, `provider/model`, or provider name (fuzzy match) to set the new session model. Nếu gửi `/new` hoặc `/reset` riêng lẻ, OpenClaw sẽ chạy một lượt chào ngắn “hello” để xác nhận việc đặt lại.
- Đặt lại thủ công: xóa các khóa cụ thể khỏi kho hoặc xóa transcript JSONL; tin nhắn tiếp theo sẽ tạo lại chúng.
- Cron job cô lập luôn tạo một `sessionId` mới cho mỗi lần chạy (không tái sử dụng khi nhàn rỗi).

## Chính sách gửi (tùy chọn)

Chặn việc gửi cho các loại phiên cụ thể mà không cần liệt kê từng id.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Ghi đè lúc chạy (chỉ chủ sở hữu):

- `/send on` → cho phép cho phiên này
- `/send off` → từ chối cho phiên này
- `/send inherit` → xóa ghi đè và dùng quy tắc cấu hình
  Gửi các lệnh này như các thông điệp độc lập để chúng được ghi nhận.

## Cấu hình (ví dụ đổi tên tùy chọn)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## Kiểm tra

- `openclaw status` — hiển thị đường dẫn kho và các phiên gần đây.
- `openclaw sessions --json` — đổ toàn bộ mọi mục (lọc bằng `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — lấy các phiên từ gateway đang chạy (dùng `--url`/`--token` để truy cập gateway từ xa).
- Gửi `/status` như một thông điệp độc lập trong chat để xem tác tử có thể truy cập hay không, bao nhiêu ngữ cảnh phiên đang được dùng, các bật/tắt suy nghĩ/verbose hiện tại, và thời điểm thông tin xác thực WhatsApp web của bạn được làm mới lần cuối (giúp phát hiện nhu cầu liên kết lại).
- Gửi `/context list` hoặc `/context detail` để xem nội dung trong system prompt và các tệp workspace được chèn (và các nguồn đóng góp ngữ cảnh lớn nhất).
- Gửi `/stop` như một thông điệp độc lập để hủy lần chạy hiện tại, xóa các followup đang xếp hàng cho phiên đó, và dừng mọi lần chạy tác tử con được tạo từ đó (phản hồi bao gồm số lượng đã dừng).
- Send `/compact` (optional instructions) as a standalone message to summarize older context and free up window space. Xem [/concepts/compaction](/concepts/compaction).
- Transcript JSONL có thể được mở trực tiếp để xem toàn bộ lượt.

## Mẹo

- Giữ khóa chính dành riêng cho lưu lượng 1:1; để các nhóm dùng khóa riêng của họ.
- Khi tự động dọn dẹp, hãy xóa từng khóa riêng lẻ thay vì toàn bộ kho để giữ ngữ cảnh ở nơi khác.

## Metadata nguồn gốc phiên

Mỗi mục phiên ghi lại nơi nó đến từ đâu (theo mức tốt nhất có thể) trong `origin`:

- `label`: nhãn cho con người (giải quyết từ nhãn cuộc trò chuyện + chủ đề nhóm/kênh)
- `provider`: id kênh đã chuẩn hóa (bao gồm các phần mở rộng)
- `from`/`to`: id định tuyến thô từ phong bì vào
- `accountId`: id tài khoản nhà cung cấp (khi nhiều tài khoản)
- `threadId`: id của luồng/chủ đề khi kênh hỗ trợ
  Các trường origin được điền cho tin nhắn trực tiếp, kênh và nhóm. If a
  connector only updates delivery routing (for example, to keep a DM main session
  fresh), it should still provide inbound context so the session keeps its
  explainer metadata. Các extension có thể làm điều này bằng cách gửi `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace` và `SenderName` trong ngữ cảnh
  inbound và gọi `recordSessionMetaFromInbound` (hoặc truyền cùng ngữ cảnh đó
  cho `updateLastRoute`).
