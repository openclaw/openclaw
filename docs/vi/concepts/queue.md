---
summary: "Thiết kế hàng đợi lệnh để tuần tự hóa các lần chạy auto-reply đến"
read_when:
  - Thay đổi cách thực thi hoặc mức song song của auto-reply
title: "Hàng đợi lệnh"
---

# Hàng đợi lệnh (2026-01-16)

Chúng tôi tuần tự hóa các lần chạy auto-reply đến (tất cả kênh) thông qua một hàng đợi nhỏ chạy trong tiến trình để ngăn nhiều lần chạy của tác tử va chạm với nhau, đồng thời vẫn cho phép song song an toàn giữa các phiên.

## Vì sao

- Các lần chạy auto-reply có thể tốn kém (gọi LLM) và có thể va chạm khi nhiều tin nhắn đến trong thời gian ngắn.
- Tuần tự hóa giúp tránh tranh chấp tài nguyên dùng chung (tệp phiên, log, stdin của CLI) và giảm khả năng chạm giới hạn tốc độ từ phía upstream.

## Cách hoạt động

- Một hàng đợi FIFO nhận biết lane sẽ xả từng lane với giới hạn song song có thể cấu hình (mặc định 1 cho các lane chưa cấu hình; main mặc định 4, subagent 8).
- `runEmbeddedPiAgent` xếp hàng theo **khóa phiên** (lane `session:<key>`) để đảm bảo chỉ có một lần chạy đang hoạt động cho mỗi phiên.
- Mỗi lần chạy của phiên sau đó được xếp vào **lane toàn cục** (`main` theo mặc định) để tổng mức song song bị giới hạn bởi `agents.defaults.maxConcurrent`.
- Khi bật log chi tiết, các lần chạy bị xếp hàng sẽ phát ra thông báo ngắn nếu chúng phải đợi hơn ~2 giây trước khi bắt đầu.
- Chỉ báo đang gõ vẫn được kích hoạt ngay khi enqueue (khi kênh hỗ trợ), vì vậy trải nghiệm người dùng không thay đổi trong khi chờ đến lượt.

## Chế độ hàng đợi (theo từng kênh)

Tin nhắn đến có thể điều hướng lần chạy hiện tại, chờ lượt tiếp theo, hoặc làm cả hai:

- `steer`: chèn ngay lập tức vào lượt chạy hiện tại (hủy các lệnh gọi công cụ đang chờ sau ranh giới công cụ tiếp theo). 25. Nếu không stream, sẽ quay về followup.
- `followup`: xếp hàng cho lượt tác tử tiếp theo sau khi lần chạy hiện tại kết thúc.
- `collect`: gộp tất cả các tin nhắn đang xếp hàng thành **một** lượt phản hồi tiếp theo (mặc định). Nếu các tin nhắn nhắm tới các kênh/luồng khác nhau, chúng sẽ được xả riêng lẻ để giữ nguyên định tuyến.
- `steer-backlog` (còn gọi là `steer+backlog`): điều hướng ngay **và** vẫn giữ lại tin nhắn cho một lượt followup.
- `interrupt` (legacy): hủy lần chạy đang hoạt động của phiên đó, sau đó chạy tin nhắn mới nhất.
- `queue` (bí danh legacy): giống như `steer`.

28. Steer-backlog nghĩa là bạn có thể nhận được phản hồi followup sau lần chạy được steer, vì vậy
    các bề mặt streaming có thể trông như bị trùng lặp. 29. Ưu tiên `collect`/`steer` nếu bạn muốn
    một phản hồi cho mỗi thông điệp đến.
29. Gửi `/queue collect` như một lệnh độc lập (theo phiên) hoặc đặt `messages.queue.byChannel.discord: "collect"`.

Mặc định (khi không đặt trong cấu hình):

- Tất cả bề mặt → `collect`

Cấu hình toàn cục hoặc theo kênh thông qua `messages.queue`:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Tùy chọn hàng đợi

Các tùy chọn áp dụng cho `followup`, `collect` và `steer-backlog` (và cho `steer` khi nó rơi về followup):

- `debounceMs`: chờ yên lặng trước khi bắt đầu một lượt followup (ngăn “tiếp tục, tiếp tục”).
- `cap`: số lượng tin nhắn tối đa được xếp hàng cho mỗi phiên.
- `drop`: chính sách tràn (`old`, `new`, `summarize`).

31. Summarize giữ một danh sách gạch đầu dòng ngắn các thông điệp bị loại và chèn nó như một prompt followup tổng hợp.
32. Mặc định: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Ghi đè theo phiên

- Gửi `/queue <mode>` như một lệnh độc lập để lưu chế độ cho phiên hiện tại.
- Có thể kết hợp các tùy chọn: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` hoặc `/queue reset` sẽ xóa ghi đè của phiên.

## Phạm vi và đảm bảo

- Áp dụng cho các lần chạy tác tử auto-reply trên tất cả các kênh đến sử dụng pipeline trả lời của gateway (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, v.v.).
- Lane mặc định (`main`) là dùng chung toàn tiến trình cho inbound + heartbeat chính; đặt `agents.defaults.maxConcurrent` để cho phép nhiều phiên chạy song song.
- Có thể tồn tại các lane bổ sung (ví dụ `cron`, `subagent`) để các job nền chạy song song mà không chặn phản hồi inbound.
- Lane theo phiên đảm bảo chỉ có một lần chạy tác tử chạm vào một phiên tại cùng thời điểm.
- Không có phụ thuộc bên ngoài hay luồng worker nền; thuần TypeScript + promises.

## Xử lý sự cố

- Nếu lệnh có vẻ bị kẹt, hãy bật log chi tiết và tìm các dòng “queued for …ms” để xác nhận hàng đợi đang được xả.
- Nếu bạn cần độ sâu hàng đợi, hãy bật log chi tiết và theo dõi các dòng thời gian của hàng đợi.
