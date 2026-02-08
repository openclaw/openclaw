---
summary: "Cách gửi một PR có tín hiệu cao"
title: "Gửi PR"
x-i18n:
  source_path: help/submitting-a-pr.md
  source_hash: 277b0f51b948d1a9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:11Z
---

PR tốt thì dễ review: người review có thể nhanh chóng hiểu mục đích, xác minh hành vi và triển khai thay đổi một cách an toàn. Hướng dẫn này tập trung vào cách gửi PR ngắn gọn, giàu tín hiệu cho cả con người và LLM review.

## Điều gì tạo nên một PR tốt

- [ ] Giải thích vấn đề, vì sao nó quan trọng và thay đổi được đề xuất.
- [ ] Giữ phạm vi thay đổi tập trung. Tránh refactor diện rộng.
- [ ] Tóm tắt các thay đổi có thể thấy với người dùng/cấu hình/giá trị mặc định.
- [ ] Liệt kê phạm vi test, các test bị bỏ qua và lý do.
- [ ] Thêm bằng chứng: log, ảnh chụp màn hình hoặc bản ghi (UI/UX).
- [ ] Code word: đặt “lobster-biscuit” trong mô tả PR nếu bạn đã đọc hướng dẫn này.
- [ ] Chạy/sửa các lệnh `pnpm` liên quan trước khi tạo PR.
- [ ] Tìm kiếm trong codebase và GitHub các chức năng/vấn đề/bản sửa liên quan.
- [ ] Dựa trên bằng chứng hoặc quan sát để đưa ra nhận định.
- [ ] Tiêu đề tốt: động từ + phạm vi + kết quả (ví dụ: `Docs: add PR and issue templates`).

Hãy ngắn gọn; review súc tích > ngữ pháp. Bỏ qua mọi mục không áp dụng.

### Lệnh xác thực cơ bản (chạy/sửa lỗi cho thay đổi của bạn)

- `pnpm lint`
- `pnpm check`
- `pnpm build`
- `pnpm test`
- Thay đổi giao thức: `pnpm protocol:check`

## Tiết lộ theo từng bước

- Trên cùng: tóm tắt/mục đích
- Tiếp theo: thay đổi/rủi ro
- Tiếp theo: test/xác minh
- Cuối cùng: triển khai/bằng chứng

## Các loại PR phổ biến: lưu ý cụ thể

- [ ] Fix: Thêm cách tái hiện, nguyên nhân gốc rễ, cách xác minh.
- [ ] Feature: Thêm các trường hợp sử dụng, hành vi/demo/ảnh chụp màn hình (UI).
- [ ] Refactor: Nêu rõ "không thay đổi hành vi", liệt kê những gì được di chuyển/đơn giản hóa.
- [ ] Chore: Nêu lý do (ví dụ: thời gian build, CI, phụ thuộc).
- [ ] Docs: Ngữ cảnh trước/sau, liên kết trang đã cập nhật, chạy `pnpm format`.
- [ ] Test: Khoảng trống nào được bao phủ; cách ngăn ngừa hồi quy.
- [ ] Perf: Thêm số liệu trước/sau và cách đo.
- [ ] UX/UI: Ảnh chụp màn hình/video, ghi chú tác động tới khả năng tiếp cận.
- [ ] Infra/Build: Môi trường/xác thực.
- [ ] Security: Tóm tắt rủi ro, cách tái hiện, xác minh, không dữ liệu nhạy cảm. Chỉ nêu nhận định có căn cứ.

## Checklist

- [ ] Vấn đề/mục đích rõ ràng
- [ ] Phạm vi tập trung
- [ ] Liệt kê thay đổi hành vi
- [ ] Liệt kê và kết quả test
- [ ] Các bước test thủ công (khi áp dụng)
- [ ] Không có bí mật/dữ liệu riêng tư
- [ ] Dựa trên bằng chứng

## Mẫu PR chung

```md
#### Summary

#### Behavior Changes

#### Codebase and GitHub Search

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort (self-reported):
- Agent notes (optional, cite evidence):
```

## Mẫu theo loại PR (thay thế bằng loại của bạn)

### Fix

```md
#### Summary

#### Repro Steps

#### Root Cause

#### Behavior Changes

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Feature

```md
#### Summary

#### Use Cases

#### Behavior Changes

#### Existing Functionality Check

- [ ] I searched the codebase for existing functionality.
      Searches performed (1-3 bullets):
  -
  -

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Refactor

```md
#### Summary

#### Scope

#### No Behavior Change Statement

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Chore/Maintenance

```md
#### Summary

#### Why This Matters

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Docs

```md
#### Summary

#### Pages Updated

#### Before/After

#### Formatting

pnpm format

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Test

```md
#### Summary

#### Gap Covered

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Perf

```md
#### Summary

#### Baseline

#### After

#### Measurement Method

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### UX/UI

```md
#### Summary

#### Screenshots or Video

#### Accessibility Impact

#### Tests

#### Manual Testing

### Prerequisites

-

### Steps

1.
2. **Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Infra/Build

```md
#### Summary

#### Environments Affected

#### Validation Steps

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```

### Security

```md
#### Summary

#### Risk Summary

#### Repro Steps

#### Mitigation or Fix

#### Verification

#### Tests

#### Manual Testing (omit if N/A)

### Prerequisites

-

### Steps

1.
2.

#### Evidence (omit if N/A)

**Sign-Off**

- Models used:
- Submitter effort:
- Agent notes:
```
