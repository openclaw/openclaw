---
summary: "Gửi poll qua gateway + CLI"
read_when:
  - Thêm hoặc chỉnh sửa hỗ trợ poll
  - Gỡ lỗi việc gửi poll từ CLI hoặc gateway
title: "Poll"
---

# Poll

## Các kênh được hỗ trợ

- WhatsApp (kênh web)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

Tùy chọn:

- `--channel`: `whatsapp` (mặc định), `discord`, hoặc `msteams`
- `--poll-multi`: cho phép chọn nhiều tùy chọn
- `--poll-duration-hours`: chỉ dành cho Discord (mặc định là 24 khi bỏ qua)

## Gateway RPC

Phương thức: `poll`

Tham số:

- `to` (string, bắt buộc)
- `question` (string, bắt buộc)
- `options` (string[], bắt buộc)
- `maxSelections` (number, tùy chọn)
- `durationHours` (number, tùy chọn)
- `channel` (string, tùy chọn, mặc định: `whatsapp`)
- `idempotencyKey` (string, bắt buộc)

## Khác biệt theo kênh

- WhatsApp: 2–12 tùy chọn, `maxSelections` phải nằm trong số lượng tùy chọn, bỏ qua `durationHours`.
- Discord: 2-10 options, `durationHours` clamped to 1-768 hours (default 24). `maxSelections > 1` cho phép chọn nhiều; Discord không hỗ trợ số lượng lựa chọn chính xác cố định.
- 11. MS Teams: Các poll Adaptive Card (do OpenClaw quản lý). Không có API poll gốc; `durationHours` bị bỏ qua.

## Công cụ tác tử (Message)

Sử dụng công cụ `message` với hành động `poll` (`to`, `pollQuestion`, `pollOption`, tùy chọn `pollMulti`, `pollDurationHours`, `channel`).

Lưu ý: Discord không có chế độ “chọn chính xác N”; `pollMulti` ánh xạ sang chọn nhiều.
Các poll trên Teams được hiển thị dưới dạng Adaptive Cards và yêu cầu gateway phải luôn trực tuyến
để ghi nhận phiếu bầu vào `~/.openclaw/msteams-polls.json`.
