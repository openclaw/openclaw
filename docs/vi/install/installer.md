---
summary: "Cách các script cài đặt hoạt động (install.sh, install-cli.sh, install.ps1), các cờ và tự động hóa"
read_when:
  - Bạn muốn hiểu `openclaw.ai/install.sh`
  - Bạn muốn tự động hóa cài đặt (CI / không giao diện)
  - Bạn muốn cài đặt từ một bản checkout GitHub
title: "Nội bộ trình cài đặt"
---

# Nội bộ trình cài đặt

OpenClaw cung cấp ba script cài đặt, được phân phối từ `openclaw.ai`.

| Script                             | Nền tảng                                | Chức năng                                                                                                                          |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`install.sh`](#installsh)         | macOS / Linux / WSL                     | Cài Node nếu cần, cài OpenClaw qua npm (mặc định) hoặc git, và có thể chạy onboarding.          |
| [`install-cli.sh`](#install-clish) | macOS / Linux / WSL                     | Installs Node + OpenClaw into a local prefix (`~/.openclaw`). No root required. |
| [`install.ps1`](#installps1)       | Windows (PowerShell) | Cài Node nếu cần, cài OpenClaw qua npm (mặc định) hoặc git, và có thể chạy onboarding.          |

## Lệnh nhanh

<Tabs>
  <Tab title="install.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install-cli.sh">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```

    ````
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --help
    ```
    ````

  </Tab>
  <Tab title="install.ps1">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```

    ````
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun
    ```
    ````

  </Tab>
</Tabs>

<Note>
Nếu cài đặt thành công nhưng `openclaw` không được tìm thấy trong terminal mới, hãy xem [Xử lý sự cố Node.js](/install/node#troubleshooting).
</Note>

---

## install.sh

<Tip>
Được khuyến nghị cho hầu hết các cài đặt tương tác trên macOS/Linux/WSL.
</Tip>

### Luồng (install.sh)

<Steps>
  <Step title="Detect OS">
    Bí danh: `--method` If macOS is detected, installs Homebrew if missing.
  </Step>
  <Step title="Ensure Node.js 22+">
    Kiểm tra phiên bản Node và cài Node 22 nếu cần (Homebrew trên macOS, script thiết lập NodeSource trên Linux apt/dnf/yum).
  </Step>
  <Step title="Ensure Git">
    Cài Git nếu chưa có.
  </Step>
  <Step title="Install OpenClaw">
    - Phương thức `npm` (mặc định): cài npm toàn cục
    - Phương thức `git`: clone/cập nhật repo, cài phụ thuộc bằng pnpm, build, rồi cài wrapper tại `~/.local/bin/openclaw`
  </Step>
  <Step title="Post-install tasks">
    - Chạy `openclaw doctor --non-interactive` khi nâng cấp và cài bằng git (cố gắng hết mức)
    - Thử chạy onboarding khi phù hợp (có TTY, onboarding không bị tắt, và các kiểm tra bootstrap/cấu hình đạt)
    - Mặc định `SHARP_IGNORE_GLOBAL_LIBVIPS=1`
  </Step>
</Steps>

### Phát hiện source checkout

Nếu chạy bên trong một checkout OpenClaw (`package.json` + `pnpm-workspace.yaml`), script sẽ đề nghị:

- dùng checkout (`git`), hoặc
- dùng cài đặt toàn cục (`npm`)

Nếu không có TTY và không đặt phương thức cài, mặc định sẽ là `npm` và hiển thị cảnh báo.

Script thoát với mã `2` khi chọn phương thức không hợp lệ hoặc giá trị `--install-method` không hợp lệ.

### Ví dụ (install.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Skip onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
    ```
  </Tab>
  <Tab title="Git install">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git
    ```
  </Tab>
  <Tab title="Dry run">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --dry-run
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                              | Mô tả                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--install-method npm\\|git`     | Choose install method (default: `npm`). Ứng dụng macOS kiểm tra phiên bản gateway so với phiên bản của chính nó. |
| `--npm`                           | Lối tắt cho phương thức npm                                                                                                                                                         |
| `--git`                           | Lối tắt cho phương thức git. Alias: `--github`                                                                                                      |
| `--version <version\\|dist-tag>` | Phiên bản npm hoặc dist-tag (mặc định: `latest`)                                                                                                 |
| `--beta`                          | Dùng dist-tag beta nếu có, nếu không thì quay về `latest`                                                                                                                           |
| `--git-dir <path>`                | Checkout directory (default: `~/openclaw`). Alias: `--dir`                                                       |
| `--no-git-update`                 | Bỏ qua `git pull` cho checkout hiện có                                                                                                                                              |
| `--no-prompt`                     | Tắt lời nhắc                                                                                                                                                                        |
| `--no-onboard`                    | Bỏ qua onboarding                                                                                                                                                                   |
| `--onboard`                       | Bật onboarding                                                                                                                                                                      |
| `--dry-run`                       | In các hành động mà không áp dụng thay đổi                                                                                                                                          |
| `--verbose`                       | Bật đầu ra debug (`set -x`, log npm mức notice)                                                                                                                  |
| `--help`                          | Hiển thị cách dùng (`-h`)                                                                                                                                        |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | Mô tả                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm`            | Phương thức cài                                                                     |
| `OPENCLAW_VERSION=latest\\|next\\|<semver>`   | Phiên bản npm hoặc dist-tag                                                         |
| `OPENCLAW_BETA=0\\|1`                          | Dùng beta nếu có                                                                    |
| `OPENCLAW_GIT_DIR=<path>`                       | Thư mục checkout                                                                    |
| `OPENCLAW_GIT_UPDATE=0\\|1`                    | Bật/tắt cập nhật git                                                                |
| `OPENCLAW_NO_PROMPT=1`                          | Tắt lời nhắc                                                                        |
| `OPENCLAW_NO_ONBOARD=1`                         | Bỏ qua onboarding                                                                   |
| `OPENCLAW_DRY_RUN=1`                            | Chế độ chạy thử                                                                     |
| `OPENCLAW_VERBOSE=1`                            | Chế độ debug                                                                        |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Mức log npm                                                                         |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Điều khiển hành vi sharp/libvips (mặc định: `1`) |

  </Accordion>
</AccordionGroup>

---

## install-cli.sh

<Info>
Được thiết kế cho môi trường mà bạn muốn mọi thứ nằm dưới một prefix cục bộ (mặc định `~/.openclaw`) và không phụ thuộc Node hệ thống.
</Info>

### Luồng (install-cli.sh)

<Steps>
  <Step title="Install local Node runtime">
    Tải tarball Node (mặc định `22.22.0`) vào `<prefix>/tools/node-v<version>` và xác minh SHA-256.
  </Step>
  <Step title="Ensure Git">
    Nếu thiếu Git, thử cài qua apt/dnf/yum trên Linux hoặc Homebrew trên macOS.
  </Step>
  <Step title="Install OpenClaw under prefix">
    Cài bằng npm sử dụng `--prefix <prefix>`, sau đó ghi wrapper vào `<prefix>/bin/openclaw`.
  </Step>
</Steps>

### Ví dụ (install-cli.sh)

<Tabs>
  <Tab title="Default">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash
    ```
  </Tab>
  <Tab title="Custom prefix + version">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /opt/openclaw --version latest
    ```
  </Tab>
  <Tab title="Automation JSON output">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="Run onboarding">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --onboard
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                   | Mô tả                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `--prefix <path>`      | Prefix cài đặt (mặc định: `~/.openclaw`)              |
| `--version <ver>`      | Phiên bản OpenClaw hoặc dist-tag (mặc định: `latest`) |
| `--node-version <ver>` | Phiên bản Node (mặc định: `22.22.0`)                  |
| `--json`               | Phát sự kiện NDJSON                                                                      |
| `--onboard`            | Chạy `openclaw onboard` sau khi cài                                                      |
| `--no-onboard`         | Bỏ qua onboarding (mặc định)                                          |
| `--set-npm-prefix`     | Trên Linux, ép prefix npm sang `~/.npm-global` nếu prefix hiện tại không ghi được        |
| `--help`               | Hiển thị cách dùng (`-h`)                                             |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                                        | Mô tả                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `OPENCLAW_PREFIX=<path>`                        | Prefix cài đặt                                                                                     |
| `OPENCLAW_VERSION=<ver>`                        | Phiên bản OpenClaw hoặc dist-tag                                                                   |
| `OPENCLAW_NODE_VERSION=<ver>`                   | Phiên bản Node                                                                                     |
| `OPENCLAW_NO_ONBOARD=1`                         | Bỏ qua onboarding                                                                                  |
| `OPENCLAW_NPM_LOGLEVEL=error\\|warn\\|notice` | Mức log npm                                                                                        |
| `OPENCLAW_GIT_DIR=<path>`                       | Đường dẫn tra cứu dọn dẹp legacy (dùng khi gỡ checkout submodule `Peekaboo` cũ) |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\\|1`            | Điều khiển hành vi sharp/libvips (mặc định: `1`)                |

  </Accordion>
</AccordionGroup>

---

## install.ps1

### Luồng (install.ps1)

<Steps>
  <Step title="Ensure PowerShell + Windows environment">
    Yêu cầu PowerShell 5+.
  </Step>
  <Step title="Ensure Node.js 22+">
    Nếu thiếu, thử cài qua winget, sau đó Chocolatey, rồi Scoop.
  </Step>
  <Step title="Install OpenClaw">
    - Phương thức `npm` (mặc định): cài npm toàn cục bằng `-Tag` đã chọn
    - Phương thức `git`: clone/cập nhật repo, cài/build với pnpm, và cài wrapper tại `%USERPROFILE%\.local\bin\openclaw.cmd`
  </Step>
  <Step title="Post-install tasks">
    Thêm thư mục bin cần thiết vào PATH người dùng khi có thể, sau đó chạy `openclaw doctor --non-interactive` khi nâng cấp và cài bằng git (cố gắng hết mức).
  </Step>
</Steps>

### Ví dụ (install.ps1)

<Tabs>
  <Tab title="Default">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
  <Tab title="Git install">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git
    ```
  </Tab>
  <Tab title="Custom git directory">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git -GitDir "C:\openclaw"
    ```
  </Tab>
  <Tab title="Dry run">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -DryRun
    ```
  </Tab>
</Tabs>

<AccordionGroup>
  <Accordion title="Flags reference">

| Flag                        | Mô tả                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `-InstallMethod npm\\|git` | Phương thức cài (mặc định: `npm`)                      |
| `-Tag <tag>`                | dist-tag npm (mặc định: `latest`)                      |
| `-GitDir <path>`            | Thư mục checkout (mặc định: `%USERPROFILE%\openclaw`) |
| `-NoOnboard`                | Bỏ qua onboarding                                                                         |
| `-NoGitUpdate`              | Bỏ qua `git pull`                                                                         |
| `-DryRun`                   | Chỉ in các hành động                                                                      |

  </Accordion>

  <Accordion title="Environment variables reference">

| Variable                             | Mô tả             |
| ------------------------------------ | ----------------- |
| `OPENCLAW_INSTALL_METHOD=git\\|npm` | Phương thức cài   |
| `OPENCLAW_GIT_DIR=<path>`            | Thư mục checkout  |
| `OPENCLAW_NO_ONBOARD=1`              | Bỏ qua onboarding |
| `OPENCLAW_GIT_UPDATE=0`              | Tắt git pull      |
| `OPENCLAW_DRY_RUN=1`                 | Chế độ chạy thử   |

  </Accordion>
</AccordionGroup>

<Note>
Nếu dùng `-InstallMethod git` và thiếu Git, script sẽ thoát và in liên kết Git for Windows.
</Note>

---

## CI và tự động hóa

Dùng các cờ/biến môi trường không tương tác để chạy ổn định, dự đoán được.

<Tabs>
  <Tab title="install.sh (non-interactive npm)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard
    ```
  </Tab>
  <Tab title="install.sh (non-interactive git)">
    ```bash
    OPENCLAW_INSTALL_METHOD=git OPENCLAW_NO_PROMPT=1 \
      curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="install-cli.sh (JSON)">
    ```bash
    curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --json --prefix /opt/openclaw
    ```
  </Tab>
  <Tab title="install.ps1 (skip onboarding)">
    ```powershell
    & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard
    ```
  </Tab>
</Tabs>

---

## Xử lý sự cố

<AccordionGroup>
  <Accordion title="Why is Git required?">
    Git is required for `git` install method. For `npm` installs, Git is still checked/installed to avoid `spawn git ENOENT` failures when dependencies use git URLs.
  </Accordion>

  <Accordion title="Why does npm hit EACCES on Linux?">
    Some Linux setups point npm global prefix to root-owned paths. `install.sh` có thể chuyển prefix sang `~/.npm-global` và thêm các lệnh export PATH vào các file rc của shell (khi các file đó tồn tại).
  </Accordion>

  <Accordion title="sharp/libvips issues">
    Các script mặc định `SHARP_IGNORE_GLOBAL_LIBVIPS=1` để tránh việc sharp build dựa trên libvips của hệ thống. To override:

    ````
    ```bash
    SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
    ```
    ````

  </Accordion>

  <Accordion title='Windows: "npm error spawn git / ENOENT"'>
    Cài Git for Windows, mở lại PowerShell, chạy lại trình cài đặt.
  </Accordion>

  <Accordion title='Windows: "openclaw is not recognized"'>
    Chạy `npm config get prefix`, thêm `\bin`, thêm thư mục đó vào PATH người dùng, rồi mở lại PowerShell.
  </Accordion>

  <Accordion title="openclaw not found after install">
    Thường là vấn đề về PATH. See [Node.js troubleshooting](/install/node#troubleshooting).
  </Accordion>
</AccordionGroup>
