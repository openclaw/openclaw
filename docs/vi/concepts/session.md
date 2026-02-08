---
summary: "Quy tắc quản lý phiên, khóa và tính bền vững cho các cuộc trò chuyện"
read_when:
  - Sửa đổi cách xử lý hoặc lưu trữ phiên
title: "Quản lý phiên"
x-i18n:
  source_path: concepts/session.md
  source_hash: e2040cea1e0738a8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:02Z
---

# Quản lý phiên

OpenClaw coi **một phiên chat trực tiếp cho mỗi tác tử** là chính. Chat trực tiếp được gộp về `agent:<agentId>:<mainKey>` (mặc định `main`), trong khi chat nhóm/kênh có các khóa riêng. `session.mainKey` được tuân thủ.

Dùng `session.dmScope` để kiểm soát cách **tin nhắn trực tiếp (DM)** được nhóm lại:

- `main` (mặc định): tất cả DM chia sẻ phiên chính để đảm bảo tính liên tục.
- `per-peer`: tách theo id người gửi trên các kênh.
- `per-channel-peer`: tách theo kênh + người gửi (khuyến nghị cho hộp thư nhiều người dùng).
- `per-account-channel-peer`: tách theo tài khoản + kênh + người gửi (khuyến nghị cho hộp thư nhiều tài khoản).
  Dùng `session.identityLinks` để ánh xạ peer id có tiền tố nhà cung cấp sang một danh tính chuẩn, để cùng một người dùng chung một phiên DM trên nhiều kênh khi dùng `per-peer`, `per-channel-peer` hoặc `per-account-channel-peer`.

## Chế độ DM an toàn (khuyến nghị cho thiết lập nhiều người dùng)

> **Cảnh báo bảo mật:** Nếu tác tử của bạn có thể nhận DM từ **nhiều người**, bạn nên cân nhắc mạnh mẽ việc bật chế độ DM an toàn. Nếu không, tất cả người dùng sẽ chia sẻ cùng một ngữ cảnh hội thoại, có thể làm lộ thông tin riêng tư giữa các người dùng.

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

- Mặc định là `dmScope: "main"` để đảm bảo tính liên tục (tất cả DM chia sẻ phiên chính). Điều này phù hợp cho thiết lập một người dùng.
- Với hộp thư nhiều tài khoản trên cùng một kênh, ưu tiên `per-account-channel-peer`.
- Nếu cùng một người liên hệ bạn trên nhiều kênh, dùng `session.identityLinks` để gộp các phiên DM của họ thành một danh tính chuẩn.
- Bạn có thể kiểm tra thiết lập DM bằng `openclaw security audit` (xem [security](/cli/security)).

## Gateway là nguồn sự thật

Toàn bộ trạng thái phiên được **sở hữu bởi gateway** (OpenClaw “chủ”). Các UI client (ứng dụng macOS, WebChat, v.v.) phải truy vấn gateway để lấy danh sách phiên và số token thay vì đọc tệp cục bộ.

- Ở **chế độ từ xa**, kho phiên mà bạn quan tâm nằm trên máy chủ gateway từ xa, không phải trên máy Mac của bạn.
- Số token hiển thị trong UI đến từ các trường lưu trữ của gateway (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Client không phân tích transcript JSONL để “sửa” tổng số.

## Trạng thái được lưu ở đâu

- Trên **máy chủ gateway**:
  - Tệp lưu trữ: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (theo từng tác tử).
- Transcript: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (phiên chủ đề Telegram dùng `.../<SessionId>-topic-<threadId>.jsonl`).
- Kho là một ánh xạ `sessionKey -> { sessionId, updatedAt, ... }`. Xóa các mục là an toàn; chúng sẽ được tạo lại khi cần.
- Các mục nhóm có thể bao gồm `displayName`, `channel`, `subject`, `room` và `space` để gắn nhãn phiên trong UI.
- Mục phiên bao gồm metadata `origin` (nhãn + gợi ý định tuyến) để UI có thể giải thích nguồn gốc phiên.
- OpenClaw **không** đọc các thư mục phiên Pi/Tau cũ.

## Cắt tỉa phiên

Theo mặc định, OpenClaw cắt bỏ **kết quả công cụ cũ** khỏi ngữ cảnh trong bộ nhớ ngay trước khi gọi LLM.
Việc này **không** ghi lại lịch sử JSONL. Xem [/concepts/session-pruning](/concepts/session-pruning).

## Xả bộ nhớ trước khi nén

Khi một phiên sắp đến ngưỡng tự động nén, OpenClaw có thể chạy một **lần xả bộ nhớ im lặng**
để nhắc mô hình ghi các ghi chú bền vững ra đĩa. Điều này chỉ chạy khi
workspace có thể ghi. Xem [Memory](/concepts/memory) và
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
- Đặt lại hằng ngày: mặc định **4:00 sáng theo giờ địa phương trên máy chủ gateway**. Một phiên được coi là cũ nếu lần cập nhật cuối sớm hơn thời điểm đặt lại hằng ngày gần nhất.
- Đặt lại khi nhàn rỗi (tùy chọn): `idleMinutes` thêm một cửa sổ nhàn rỗi trượt. Khi cả đặt lại hằng ngày và nhàn rỗi đều được cấu hình, **điều kiện hết hạn trước** sẽ buộc tạo phiên mới.
- Chỉ nhàn rỗi (cũ): nếu bạn đặt `session.idleMinutes` mà không có bất kỳ cấu hình `session.reset`/`resetByType` nào, OpenClaw sẽ ở chế độ chỉ nhàn rỗi để tương thích ngược.
- Ghi đè theo loại (tùy chọn): `resetByType` cho phép ghi đè chính sách cho các phiên `dm`, `group` và `thread` (thread = thread Slack/Discord, chủ đề Telegram, thread Matrix khi connector cung cấp).
- Ghi đè theo kênh (tùy chọn): `resetByChannel` ghi đè chính sách đặt lại cho một kênh (áp dụng cho mọi loại phiên của kênh đó và ưu tiên hơn `reset`/`resetByType`).
- Trình kích hoạt đặt lại: chính xác `/new` hoặc `/reset` (cộng với bất kỳ phần bổ sung nào trong `resetTriggers`) sẽ bắt đầu một id phiên mới và chuyển phần còn lại của thông điệp đi tiếp. `/new <model>` chấp nhận bí danh mô hình, `provider/model` hoặc tên nhà cung cấp (khớp mờ) để đặt mô hình cho phiên mới. Nếu `/new` hoặc `/reset` được gửi riêng lẻ, OpenClaw sẽ chạy một lượt chào “hello” ngắn để xác nhận việc đặt lại.
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
- Gửi `/compact` (hướng dẫn tùy chọn) như một thông điệp độc lập để tóm tắt ngữ cảnh cũ hơn và giải phóng không gian cửa sổ. Xem [/concepts/compaction](/concepts/compaction).
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
- `threadId`: id thread/chủ đề khi kênh hỗ trợ
  Các trường nguồn gốc được điền cho tin nhắn trực tiếp, kênh và nhóm. Nếu một
  connector chỉ cập nhật định tuyến gửi (ví dụ, để giữ phiên chính DM luôn mới),
  nó vẫn nên cung cấp ngữ cảnh vào để phiên giữ được metadata giải thích của nó.
  Các extension có thể làm điều này bằng cách gửi `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace` và `SenderName` trong ngữ cảnh vào
  và gọi `recordSessionMetaFromInbound` (hoặc truyền cùng ngữ cảnh
  cho `updateLastRoute`).
