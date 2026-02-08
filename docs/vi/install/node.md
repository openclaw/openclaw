---
title: "Node.js"
summary: "Cài đặt và cấu hình Node.js cho OpenClaw — yêu cầu phiên bản, các tùy chọn cài đặt và xử lý sự cố PATH"
read_when:
  - "Bạn cần cài đặt Node.js trước khi cài đặt OpenClaw"
  - "Bạn đã cài OpenClaw nhưng gặp lỗi `openclaw` là lệnh không tồn tại"
  - "`npm install -g` thất bại do quyền hoặc sự cố PATH"
x-i18n:
  source_path: install/node.md
  source_hash: f848d6473a183090
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:23Z
---

# Node.js

OpenClaw yêu cầu **Node 22 trở lên**. [Script cài đặt](/install#install-methods) sẽ tự động phát hiện và cài Node — trang này dành cho trường hợp bạn muốn tự thiết lập Node và đảm bảo mọi thứ được kết nối đúng (phiên bản, PATH, cài đặt toàn cục).

## Kiểm tra phiên bản

```bash
node -v
```

Nếu lệnh in ra `v22.x.x` hoặc cao hơn thì bạn đã sẵn sàng. Nếu Node chưa được cài hoặc phiên bản quá cũ, hãy chọn một phương thức cài đặt bên dưới.

## Cài đặt Node

<Tabs>
  <Tab title="macOS">
    **Homebrew** (khuyến nghị):

    ```bash
    brew install node
    ```

    Hoặc tải trình cài đặt macOS từ [nodejs.org](https://nodejs.org/).

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian:**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL:**

    ```bash
    sudo dnf install nodejs
    ```

    Hoặc dùng trình quản lý phiên bản (xem bên dưới).

  </Tab>
  <Tab title="Windows">
    **winget** (khuyến nghị):

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey:**

    ```powershell
    choco install nodejs-lts
    ```

    Hoặc tải trình cài đặt Windows từ [nodejs.org](https://nodejs.org/).

  </Tab>
</Tabs>

<Accordion title="Sử dụng trình quản lý phiên bản (nvm, fnm, mise, asdf)">
  Trình quản lý phiên bản cho phép bạn chuyển đổi giữa các phiên bản Node dễ dàng. Các lựa chọn phổ biến:

- [**fnm**](https://github.com/Schniz/fnm) — nhanh, đa nền tảng
- [**nvm**](https://github.com/nvm-sh/nvm) — được dùng rộng rãi trên macOS/Linux
- [**mise**](https://mise.jdx.dev/) — đa ngôn ngữ (Node, Python, Ruby, v.v.)

Ví dụ với fnm:

```bash
fnm install 22
fnm use 22
```

  <Warning>
  Hãy đảm bảo trình quản lý phiên bản của bạn được khởi tạo trong tệp khởi động shell (`~/.zshrc` hoặc `~/.bashrc`). Nếu không, `openclaw` có thể không được tìm thấy trong các phiên terminal mới vì PATH sẽ không bao gồm thư mục bin của Node.
  </Warning>
</Accordion>

## Xử lý sự cố

### `openclaw: command not found`

Điều này hầu như luôn có nghĩa là thư mục bin toàn cục của npm không nằm trong PATH của bạn.

<Steps>
  <Step title="Tìm prefix npm toàn cục">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="Kiểm tra xem nó có nằm trong PATH không">
    ```bash
    echo "$PATH"
    ```

    Tìm `<npm-prefix>/bin` (macOS/Linux) hoặc `<npm-prefix>` (Windows) trong đầu ra.

  </Step>
  <Step title="Thêm vào tệp khởi động shell của bạn">
    <Tabs>
      <Tab title="macOS / Linux">
        Thêm vào `~/.zshrc` hoặc `~/.bashrc`:

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        Sau đó mở một terminal mới (hoặc chạy `rehash` trong zsh / `hash -r` trong bash).
      </Tab>
      <Tab title="Windows">
        Thêm đầu ra của `npm prefix -g` vào PATH hệ thống qua Settings → System → Environment Variables.
      </Tab>
    </Tabs>

  </Step>
</Steps>

### Lỗi quyền khi chạy `npm install -g` (Linux)

Nếu bạn thấy lỗi `EACCES`, hãy chuyển prefix toàn cục của npm sang một thư mục có quyền ghi cho người dùng:

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

Thêm dòng `export PATH=...` vào `~/.bashrc` hoặc `~/.zshrc` để áp dụng vĩnh viễn.
