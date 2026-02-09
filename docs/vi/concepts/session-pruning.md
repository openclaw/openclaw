---
summary: "Cắt tỉa phiên: rút gọn kết quả công cụ để giảm phình to ngữ cảnh"
read_when:
  - Bạn muốn giảm tăng trưởng ngữ cảnh LLM do đầu ra công cụ
  - Bạn đang tinh chỉnh agents.defaults.contextPruning
---

# Cắt tỉa phiên

33. Cắt tỉa phiên (session pruning) loại bỏ **kết quả công cụ cũ** khỏi ngữ cảnh trong bộ nhớ ngay trước mỗi lần gọi LLM. 34. Nó **không** ghi lại lịch sử phiên trên đĩa (`*.jsonl`).

## Khi nào chạy

- Khi `mode: "cache-ttl"` được bật và lần gọi Anthropic gần nhất của phiên cũ hơn `ttl`.
- Chỉ ảnh hưởng đến các thông điệp được gửi cho mô hình trong yêu cầu đó.
- Chỉ hoạt động cho các cuộc gọi API Anthropic (và các mô hình Anthropic qua OpenRouter).
- Để đạt kết quả tốt nhất, hãy khớp `ttl` với `cacheControlTtl` của mô hình.
- Sau khi cắt tỉa, cửa sổ TTL được đặt lại để các yêu cầu tiếp theo giữ cache cho đến khi `ttl` hết hạn lại.

## Mặc định thông minh (Anthropic)

- Hồ sơ **OAuth hoặc setup-token**: bật cắt tỉa `cache-ttl` và đặt heartbeat thành `1h`.
- Hồ sơ **API key**: bật cắt tỉa `cache-ttl`, đặt heartbeat thành `30m`, và đặt mặc định `cacheControlTtl` là `1h` trên các mô hình Anthropic.
- Nếu bạn đặt bất kỳ giá trị nào trong số này một cách tường minh, OpenClaw **không** ghi đè chúng.

## Điều này cải thiện gì (chi phí + hành vi cache)

- 35. **Vì sao cần cắt tỉa:** bộ nhớ đệm prompt của Anthropic chỉ áp dụng trong TTL. 36. Nếu một phiên bị nhàn rỗi vượt quá TTL, yêu cầu tiếp theo sẽ cache lại toàn bộ prompt trừ khi bạn cắt tỉa trước.
- **Cái gì rẻ hơn:** cắt tỉa làm giảm kích thước **cacheWrite** cho yêu cầu đầu tiên sau khi TTL hết hạn.
- **Vì sao việc đặt lại TTL quan trọng:** khi cắt tỉa chạy, cửa sổ cache được đặt lại, nên các yêu cầu theo sau có thể tái sử dụng prompt vừa được cache thay vì cache lại toàn bộ lịch sử.
- **Những gì nó không làm:** cắt tỉa không thêm token hay “nhân đôi” chi phí; nó chỉ thay đổi những gì được cache ở yêu cầu đầu tiên sau TTL.

## Những gì có thể bị cắt tỉa

- Chỉ các thông điệp `toolResult`.
- Thông điệp của người dùng + trợ lý **không bao giờ** bị sửa đổi.
- `keepLastAssistants` thông điệp trợ lý gần nhất được bảo vệ; các kết quả công cụ sau mốc đó sẽ không bị cắt tỉa.
- Nếu không có đủ thông điệp trợ lý để xác lập mốc, việc cắt tỉa sẽ bị bỏ qua.
- Các kết quả công cụ chứa **khối hình ảnh** sẽ bị bỏ qua (không bao giờ bị rút gọn/xóa).

## Ước tính cửa sổ ngữ cảnh

37. Việc cắt tỉa dùng ước lượng cửa sổ ngữ cảnh (ký tự ≈ token × 4). 38. Cửa sổ cơ sở được phân giải theo thứ tự này:

1. Ghi đè `models.providers.*.models[].contextWindow`.
2. Định nghĩa mô hình `contextWindow` (từ sổ đăng ký mô hình).
3. Mặc định `200000` token.

Nếu đặt `agents.defaults.contextTokens`, giá trị này được coi là mức trần (min) cho cửa sổ đã xác định.

## Chế độ

### cache-ttl

- Cắt tỉa chỉ chạy nếu lần gọi Anthropic gần nhất cũ hơn `ttl` (mặc định `5m`).
- Khi chạy: cùng hành vi rút gọn mềm + xóa cứng như trước.

## Rút gọn mềm vs xóa cứng

- **Rút gọn mềm**: chỉ áp dụng cho các kết quả công cụ quá lớn.
  - Giữ phần đầu + phần cuối, chèn `...`, và thêm ghi chú về kích thước ban đầu.
  - Bỏ qua các kết quả có khối hình ảnh.
- **Xóa cứng**: thay thế toàn bộ kết quả công cụ bằng `hardClear.placeholder`.

## Chọn công cụ

- `tools.allow` / `tools.deny` hỗ trợ ký tự đại diện `*`.
- Từ chối (deny) được ưu tiên.
- So khớp không phân biệt hoa thường.
- Danh sách cho phép trống => cho phép tất cả công cụ.

## Tương tác với các giới hạn khác

- Các công cụ tích hợp sẵn đã tự cắt ngắn đầu ra của chúng; cắt tỉa phiên là một lớp bổ sung để ngăn các cuộc trò chuyện kéo dài tích lũy quá nhiều đầu ra công cụ trong ngữ cảnh mô hình.
- 39. Nén (compaction) là tách biệt: nén sẽ tóm tắt và lưu trữ, còn cắt tỉa là tạm thời theo từng yêu cầu. 40. Xem [/concepts/compaction](/concepts/compaction).

## Mặc định (khi được bật)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Ví dụ

Mặc định (tắt):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

Bật cắt tỉa theo TTL:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Giới hạn cắt tỉa cho các công cụ cụ thể:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Xem tham chiếu cấu hình: [Gateway Configuration](/gateway/configuration)
