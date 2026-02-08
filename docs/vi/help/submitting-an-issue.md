---
summary: "Nộp issue và báo cáo lỗi có tín hiệu cao"
title: "Gửi một Issue"
x-i18n:
  source_path: help/submitting-an-issue.md
  source_hash: bcb33f05647e9f0d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:09Z
---

## Gửi một Issue

Issue rõ ràng, súc tích giúp chẩn đoán và sửa lỗi nhanh hơn. Với lỗi, hồi quy hoặc thiếu tính năng, hãy bao gồm các mục sau:

### Những gì cần bao gồm

- [ ] Tiêu đề: khu vực & triệu chứng
- [ ] Các bước tái hiện tối thiểu
- [ ] Kỳ vọng so với thực tế
- [ ] Mức độ ảnh hưởng & mức độ nghiêm trọng
- [ ] Môi trường: OS, runtime, phiên bản, cấu hình
- [ ] Bằng chứng: log đã ẩn thông tin, ảnh chụp màn hình (không PII)
- [ ] Phạm vi: mới, hồi quy, hay tồn tại lâu dài
- [ ] Mật khẩu: lobster-biscuit trong issue của bạn
- [ ] Đã tìm trong codebase & GitHub xem có issue tương tự
- [ ] Xác nhận chưa được sửa/giải quyết gần đây (đặc biệt là bảo mật)
- [ ] Mọi khẳng định đều có bằng chứng hoặc cách tái hiện

Hãy ngắn gọn. Ngắn gọn > ngữ pháp hoàn hảo.

Xác thực (chạy/sửa trước PR):

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Nếu là mã giao thức: `pnpm protocol:check`

### Mẫu

#### Báo cáo lỗi

```md
- [ ] Minimal repro
- [ ] Expected vs actual
- [ ] Environment
- [ ] Affected channels, where not seen
- [ ] Logs/screenshots (redacted)
- [ ] Impact/severity
- [ ] Workarounds

### Summary

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact

### Workarounds
```

#### Vấn đề bảo mật

```md
### Summary

### Impact

### Versions

### Repro Steps (safe to share)

### Mitigation/workaround

### Evidence (redacted)
```

_Tránh đưa bí mật/chi tiết khai thác ra công khai. Với vấn đề nhạy cảm, hãy giảm thiểu chi tiết và yêu cầu công bố riêng tư._

#### Báo cáo hồi quy

```md
### Summary

### Last Known Good

### First Known Bad

### Repro Steps

### Expected

### Actual

### Environment

### Logs/Evidence

### Impact
```

#### Yêu cầu tính năng

```md
### Summary

### Problem

### Proposed Solution

### Alternatives

### Impact

### Evidence/examples
```

#### Cải tiến

```md
### Summary

### Current vs Desired Behavior

### Rationale

### Alternatives

### Evidence/examples
```

#### Điều tra

```md
### Summary

### Symptoms

### What Was Tried

### Environment

### Logs/Evidence

### Impact
```

### Gửi PR sửa lỗi

Issue trước PR là tùy chọn. Nếu bỏ qua, hãy đưa đầy đủ chi tiết trong PR. Giữ PR tập trung, ghi rõ số issue, thêm test hoặc giải thích lý do không có, tài liệu hóa thay đổi hành vi/rủi ro, đính kèm log/ảnh chụp màn hình đã ẩn thông tin làm bằng chứng, và chạy xác thực phù hợp trước khi gửi.
