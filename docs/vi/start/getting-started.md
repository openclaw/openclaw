---
summary: "Cài đặt OpenClaw và chạy cuộc trò chuyện đầu tiên chỉ trong vài phút."
read_when:
  - Thiết lập lần đầu từ con số không
  - Bạn muốn con đường nhanh nhất để có một cuộc trò chuyện hoạt động
title: "Bắt đầu"
---

# Bắt đầu

Mục tiêu: đi từ con số không đến cuộc trò chuyện hoạt động đầu tiên với thiết lập tối thiểu.

<Info>
Fastest chat: open the Control UI (no channel setup needed). Run `openclaw dashboard`
and chat in the browser, or open `http://127.0.0.1:18789/` on the
<Tooltip headline="Gateway host" tip="The machine running the OpenClaw gateway service.">máy chủ gateway</Tooltip>.
Docs: [Dashboard](/web/dashboard) and [Control UI](/web/control-ui).
</Info>

## Điều kiện tiên quyết

- Node 22 hoặc mới hơn

<Tip>
Kiểm tra phiên bản Node của bạn bằng `node --version` nếu bạn chưa chắc chắn.
</Tip>

## Thiết lập nhanh (CLI)

<Steps>
  <Step title="Install OpenClaw (recommended)">
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

    ```
    <Note>
    Các phương thức cài đặt khác và yêu cầu: [Install](/install).
    </Note>
    ```

  </Step>
  <Step title="Run the onboarding wizard">
    ```bash
    openclaw onboard --install-daemon
    ```

    ```
    Trình hướng dẫn cấu hình xác thực, cài đặt gateway và các kênh tùy chọn.
    Xem [Onboarding Wizard](/start/wizard) để biết chi tiết.
    ```

  </Step>
  <Step title="Check the Gateway">
    Nếu bạn đã cài đặt dịch vụ, nó sẽ chạy sẵn:

    ````
    ```bash
    openclaw gateway status
    ```
    ````

  </Step>
  <Step title="Open the Control UI">
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
  <Accordion title="Run the Gateway in the foreground">
    Hữu ích cho kiểm tra nhanh hoặc xử lý sự cố.

    ````
    ```bash
    openclaw gateway --port 18789
    ```
    ````

  </Accordion>
  <Accordion title="Send a test message">
    Yêu cầu một kênh đã được cấu hình.

    ````
    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```
    ````

  </Accordion>
</AccordionGroup>

## Tìm hiểu sâu hơn

<Columns>
  <Card title="Onboarding Wizard (details)" href="/start/wizard">
    Tài liệu tham chiếu đầy đủ cho trình hướng dẫn CLI và các tùy chọn nâng cao.
  </Card>
  <Card title="macOS app onboarding" href="/start/onboarding">
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
