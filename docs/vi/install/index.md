---
summary: "Cài đặt OpenClaw — script cài đặt, npm/pnpm, từ mã nguồn, Docker, và hơn thế nữa"
read_when:
  - Bạn cần một phương thức cài đặt khác ngoài quickstart Bắt đầu
  - Bạn muốn triển khai lên nền tảng đám mây
  - Bạn cần cập nhật, di chuyển hoặc gỡ cài đặt
title: "Cài đặt"
x-i18n:
  source_path: install/index.md
  source_hash: 67c029634ba38196
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:24Z
---

# Cài đặt

Đã làm theo [Bắt đầu](/start/getting-started)? Vậy là xong — trang này dành cho các phương thức cài đặt thay thế, hướng dẫn theo nền tảng, và bảo trì.

## Yêu cầu hệ thống

- **[Node 22+](/install/node)** (script cài đặt sẽ tự cài nếu thiếu)
- macOS, Linux hoặc Windows
- `pnpm` chỉ khi bạn build từ mã nguồn

<Note>
Trên Windows, chúng tôi đặc biệt khuyến nghị chạy OpenClaw dưới [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install).
</Note>

## Phương thức cài đặt

<Tip>
**Script cài đặt** là cách được khuyến nghị để cài OpenClaw. Nó xử lý việc phát hiện Node, cài đặt và hướng dẫn ban đầu trong một bước.
</Tip>

<AccordionGroup>
  <Accordion title="Script cài đặt" icon="rocket" defaultOpen>
    Tải CLI, cài đặt toàn cục qua npm và khởi chạy trình hướng dẫn onboarding.

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
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

    Vậy là xong — script sẽ xử lý việc phát hiện Node, cài đặt và onboarding.

    Để bỏ qua onboarding và chỉ cài binary:

    <Tabs>
      <Tab title="macOS / Linux / WSL2">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
        ```
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
        ```
      </Tab>
    </Tabs>

    Để xem tất cả cờ, biến môi trường và tùy chọn CI/tự động hóa, xem [Installer internals](/install/installer).

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    Nếu bạn đã có Node 22+ và muốn tự quản lý việc cài đặt:

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="lỗi build sharp?">
          Nếu bạn đã cài libvips toàn cục (thường gặp trên macOS qua Homebrew) và `sharp` thất bại, hãy buộc dùng binary dựng sẵn:

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          Nếu bạn thấy `sharp: Please add node-gyp to your dependencies`, hãy cài công cụ build (macOS: Xcode CLT + `npm install -g node-gyp`) hoặc dùng biến môi trường ở trên.
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # approve openclaw, node-llama-cpp, sharp, etc.
        openclaw onboard --install-daemon
        ```

        <Note>
        pnpm yêu cầu phê duyệt rõ ràng cho các gói có script build. Sau khi lần cài đầu tiên hiển thị cảnh báo "Ignored build scripts", hãy chạy `pnpm approve-builds -g` và chọn các gói được liệt kê.
        </Note>
      </Tab>
    </Tabs>

  </Accordion>

  <Accordion title="Từ mã nguồn" icon="github">
    Dành cho người đóng góp hoặc bất kỳ ai muốn chạy từ bản checkout cục bộ.

    <Steps>
      <Step title="Clone và build">
        Clone [repo OpenClaw](https://github.com/openclaw/openclaw) và build:

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="Liên kết CLI">
        Làm cho lệnh `openclaw` khả dụng toàn cục:

        ```bash
        pnpm link --global
        ```

        Hoặc bỏ qua bước liên kết và chạy lệnh qua `pnpm openclaw ...` từ bên trong repo.
      </Step>
      <Step title="Chạy onboarding">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    Để xem các quy trình phát triển chuyên sâu hơn, xem [Thiết lập](/start/setup).

  </Accordion>
</AccordionGroup>

## Các phương thức cài đặt khác

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    Triển khai dạng container hoặc headless.
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    Cài đặt khai báo qua Nix.
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    Cấp phát đội máy tự động.
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    Chỉ dùng CLI qua runtime Bun.
  </Card>
</CardGroup>

## Sau khi cài đặt

Xác minh mọi thứ hoạt động bình thường:

```bash
openclaw doctor         # check for config issues
openclaw status         # gateway status
openclaw dashboard      # open the browser UI
```

## Xử lý sự cố: không tìm thấy `openclaw`

<Accordion title="Chẩn đoán và khắc phục PATH">
  Chẩn đoán nhanh:

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

Nếu `$(npm prefix -g)/bin` (macOS/Linux) hoặc `$(npm prefix -g)` (Windows) **không** nằm trong `$PATH` của bạn, shell của bạn không thể tìm thấy các binary npm toàn cục (bao gồm `openclaw`).

Cách khắc phục — thêm nó vào file khởi động shell của bạn (`~/.zshrc` hoặc `~/.bashrc`):

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

Trên Windows, thêm đầu ra của `npm prefix -g` vào PATH của bạn.

Sau đó mở một terminal mới (hoặc `rehash` trong zsh / `hash -r` trong bash).
</Accordion>

## Cập nhật / gỡ cài đặt

<CardGroup cols={3}>
  <Card title="Cập nhật" href="/install/updating" icon="refresh-cw">
    Giữ OpenClaw luôn được cập nhật.
  </Card>
  <Card title="Di chuyển" href="/install/migrating" icon="arrow-right">
    Chuyển sang máy mới.
  </Card>
  <Card title="Gỡ cài đặt" href="/install/uninstall" icon="trash-2">
    Gỡ OpenClaw hoàn toàn.
  </Card>
</CardGroup>
