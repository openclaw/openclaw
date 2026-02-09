---
summary: "Nộp issue và báo cáo lỗi có tín hiệu cao"
title: "Gửi một Issue"
---

## Gửi một Issue

Tạo issue trước PR là tùy chọn. Bao gồm các nội dung sau cho lỗi, hồi quy hoặc khoảng trống tính năng:

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

Ngắn gọn. Súc tích > ngữ pháp hoàn hảo.

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

_Tránh tiết lộ bí mật/chi tiết khai thác nơi công cộng._ Với các vấn đề nhạy cảm, giảm thiểu chi tiết và yêu cầu tiết lộ riêng tư._

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

Giữ PR tập trung, ghi chú số issue, thêm test hoặc giải thích lý do không có, tài liệu hóa các thay đổi/hệ quả về hành vi, bao gồm log/ảnh chụp màn hình đã được che thông tin nhạy cảm làm bằng chứng, và chạy xác thực phù hợp trước khi gửi. Nếu bỏ qua, hãy đưa chi tiết vào PR. Mistral: `mistral/`…
