---
title: Tái cấu trúc Mirroring Phiên Gửi Đi (Issue #1520)
description: Track outbound session mirroring refactor notes, decisions, tests, and open items.
x-i18n:
  source_path: refactor/outbound-session-mirroring.md
  source_hash: b88a72f36f7b6d8a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:06Z
---

# Tái cấu trúc Mirroring Phiên Gửi Đi (Issue #1520)

## Trạng thái

- Đang thực hiện.
- Định tuyến kênh core + plugin đã được cập nhật cho mirroring gửi đi.
- Gateway send hiện suy ra phiên đích khi sessionKey bị bỏ qua.

## Bối cảnh

Các lần gửi đi trước đây được mirror vào phiên tác tử _hiện tại_ (khóa phiên của công cụ) thay vì phiên của kênh đích. Định tuyến inbound sử dụng khóa phiên theo kênh/peer, nên các phản hồi outbound rơi vào sai phiên và các mục tiêu liên hệ lần đầu thường thiếu mục phiên.

## Mục tiêu

- Mirror thông điệp gửi đi vào khóa phiên của kênh đích.
- Tạo mục phiên khi gửi đi nếu còn thiếu.
- Giữ phạm vi thread/topic đồng bộ với khóa phiên inbound.
- Bao phủ các kênh core và các extension đi kèm.

## Tóm tắt triển khai

- Trợ giúp định tuyến phiên outbound mới:
  - `src/infra/outbound/outbound-session.ts`
  - `resolveOutboundSessionRoute` xây dựng sessionKey đích bằng `buildAgentSessionKey` (dmScope + identityLinks).
  - `ensureOutboundSessionEntry` ghi `MsgContext` tối thiểu thông qua `recordSessionMetaFromInbound`.
- `runMessageAction` (send) suy ra sessionKey đích và truyền cho `executeSendAction` để mirroring.
- `message-tool` không còn mirror trực tiếp; chỉ phân giải agentId từ khóa phiên hiện tại.
- Luồng gửi của plugin mirror qua `appendAssistantMessageToSessionTranscript` bằng sessionKey đã suy ra.
- Gateway send suy ra khóa phiên đích khi không được cung cấp (tác tử mặc định) và đảm bảo có mục phiên.

## Xử lý Thread/Topic

- Slack: replyTo/threadId -> `resolveThreadSessionKeys` (hậu tố).
- Discord: threadId/replyTo -> `resolveThreadSessionKeys` với `useSuffix=false` để khớp inbound (id kênh thread đã phạm vi hóa phiên).
- Telegram: ID topic ánh xạ tới `chatId:topic:<id>` thông qua `buildTelegramGroupPeerId`.

## Các extension được bao phủ

- Matrix, MS Teams, Mattermost, BlueBubbles, Nextcloud Talk, Zalo, Zalo Personal, Nostr, Tlon.
- Ghi chú:
  - Mục tiêu Mattermost hiện loại bỏ `@` để định tuyến khóa phiên DM.
  - Zalo Personal dùng loại peer DM cho mục tiêu 1:1 (chỉ là nhóm khi có `group:`).
  - Mục tiêu nhóm BlueBubbles loại bỏ tiền tố `chat_*` để khớp khóa phiên inbound.
  - Mirroring auto-thread của Slack khớp id kênh không phân biệt hoa thường.
  - Gateway send chuyển các khóa phiên được cung cấp sang chữ thường trước khi mirroring.

## Quyết định

- **Suy ra phiên cho Gateway send**: nếu cung cấp `sessionKey` thì dùng nó. Nếu bỏ qua, suy ra sessionKey từ mục tiêu + tác tử mặc định và mirror tại đó.
- **Tạo mục phiên**: luôn dùng `recordSessionMetaFromInbound` với `Provider/From/To/ChatType/AccountId/Originating*` căn chỉnh theo định dạng inbound.
- **Chuẩn hóa mục tiêu**: định tuyến outbound dùng các mục tiêu đã được phân giải (sau `resolveChannelTarget`) khi có.
- **Chữ hoa/thường của khóa phiên**: chuẩn hóa khóa phiên về chữ thường khi ghi và trong quá trình migration.

## Kiểm thử đã thêm/cập nhật

- `src/infra/outbound/outbound-session.test.ts`
  - Khóa phiên thread của Slack.
  - Khóa phiên topic của Telegram.
  - identityLinks dmScope với Discord.
- `src/agents/tools/message-tool.test.ts`
  - Suy ra agentId từ khóa phiên (không truyền sessionKey).
- `src/gateway/server-methods/send.test.ts`
  - Suy ra khóa phiên khi bị bỏ qua và tạo mục phiên.

## Mục mở / Theo dõi tiếp

- Plugin gọi thoại dùng các khóa phiên `voice:<phone>` tùy chỉnh. Việc ánh xạ outbound chưa được chuẩn hóa ở đây; nếu message-tool cần hỗ trợ gửi cho gọi thoại, hãy thêm ánh xạ rõ ràng.
- Xác nhận xem có plugin bên ngoài nào dùng các định dạng `From/To` không chuẩn ngoài bộ đi kèm hay không.

## Các tệp đã chạm

- `src/infra/outbound/outbound-session.ts`
- `src/infra/outbound/outbound-send-service.ts`
- `src/infra/outbound/message-action-runner.ts`
- `src/agents/tools/message-tool.ts`
- `src/gateway/server-methods/send.ts`
- Tests trong:
  - `src/infra/outbound/outbound-session.test.ts`
  - `src/agents/tools/message-tool.test.ts`
  - `src/gateway/server-methods/send.test.ts`
