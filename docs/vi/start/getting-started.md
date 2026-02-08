---
summary: "Cài đặt OpenClaw và chạy cuộc trò chuyện đầu tiên chỉ trong vài phút."
read_when:
  - Thiết lập lần đầu từ con số không
  - Bạn muốn con đường nhanh nhất để có một cuộc trò chuyện hoạt động
title: "Bắt đầu"
x-i18n:
  source_path: start/getting-started.md
  source_hash: 6eeb4d38a70f2ad9
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:16Z
---

# Bắt đầu

Mục tiêu: đi từ con số không đến cuộc trò chuyện hoạt động đầu tiên với thiết lập tối thiểu.

<Info>
Cách trò chuyện nhanh nhất: mở Control UI (không cần thiết lập kênh). Chạy `openclaw dashboard`
và trò chuyện trong trình duyệt, hoặc mở `http://127.0.0.1:18789/` trên
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">máy chủ gateway</Tooltip>.
Tài liệu: [Dashboard](/web/dashboard) và [Control UI](/web/control-ui).
</Info>

## Điều kiện tiên quyết

- Node 22 hoặc mới hơn

<Tip>
Kiểm tra phiên bản Node của bạn bằng `node --version` nếu bạn chưa chắc chắn.
</Tip>

## Thiết lập nhanh (CLI)

<Steps>
  <Step title="Cài đặt OpenClaw (khuyến nghị)">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Các phương thức cài đặt khác và yêu cầu: [Install](/install).
    </Note>

  </Step>
  <Step title="Chạy trình hướng dẫn ban đầu">
    ```bash
    openclaw onboard --install-daemon
    ```

    Trình hướng dẫn cấu hình xác thực, cài đặt gateway và các kênh tùy chọn.
    Xem [Onboarding Wizard](/start/wizard) để biết chi tiết.

  </Step>
  <Step title="Kiểm tra Gateway">
    Nếu bạn đã cài đặt dịch vụ, nó sẽ chạy sẵn:

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="Mở Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
Nếu Control UI tải được, Gateway của bạn đã sẵn sàng sử dụng.
</Check>

## Kiểm tra tùy chọn và phần bổ sung

<AccordionGroup>
  <Accordion title="Chạy Gateway ở chế độ foreground">
    Hữu ích cho kiểm tra nhanh hoặc xử lý sự cố.

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="Gửi tin nhắn kiểm tra">
    Yêu cầu một kênh đã được cấu hình.

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## Tìm hiểu sâu hơn

<Columns>
  <Card title="Onboarding Wizard (chi tiết)" href="/start/wizard">
    Tài liệu tham chiếu đầy đủ cho trình hướng dẫn CLI và các tùy chọn nâng cao.
  </Card>
  <Card title="Hướng dẫn ban đầu cho ứng dụng macOS" href="/start/onboarding">
    Quy trình chạy lần đầu cho ứng dụng macOS.
  </Card>
</Columns>

## Những gì bạn sẽ có

- Một Gateway đang chạy
- Đã cấu hình xác thực
- Quyền truy cập Control UI hoặc một kênh đã kết nối

## Bước tiếp theo

- An toàn DM và phê duyệt: [Pairing](/channels/pairing)
- Kết nối thêm kênh: [Channels](/channels)
- Quy trình nâng cao và chạy từ mã nguồn: [Setup](/start/setup)
