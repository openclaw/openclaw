---
read_when:
  - 你需要一种不同于“入门指南”快速开始的安装方式
  - 你想部署到云平台
  - 你需要更新、迁移或卸载
summary: 安装 OpenClaw —— 安装脚本、npm/pnpm、从源码、Docker 等
title: 安装
x-i18n:
  generated_at: "2026-03-16T06:23:36Z"
  model: gpt-5.4
  provider: openai
  source_hash: 14b80b6176b2a4ff5c60aad2db88460d8d980bd416faaa3103b38d90521496af
  source_path: install/index.md
  workflow: 15
---

# 安装

已经按照 [入门指南](/start/getting-started) 操作过了吗？那你已经准备好了 —— 本页适用于其他安装方法、特定平台说明以及维护操作。

## 系统要求

- **[Node 24（推荐）](/install/node)**（出于兼容性考虑，仍支持 Node 22 LTS，目前为 `22.16+`；如果缺失，[安装脚本](#install-methods) 会安装 Node 24）
- macOS、Linux 或 Windows
- 仅当你从源码构建时需要 `pnpm`

<Note>
在 Windows 上，我们强烈建议你在 [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) 下运行 OpenClaw。
</Note>

## 安装方法

<Tip>
**安装脚本** 是安装 OpenClaw 的推荐方式。它会一步完成 Node 检测、安装和新手引导。
</Tip>

<Warning>
对于 VPS/云主机，尽量避免使用第三方“一键式”市场镜像。优先选择干净的基础 OS 镜像（例如 Ubuntu LTS），然后使用安装脚本自行安装 OpenClaw。
</Warning>

<AccordionGroup>
  <Accordion title="安装脚本" icon="rocket" defaultOpen>
    下载 CLI，通过 npm 全局安装，并启动设置向导。

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

    就这样 —— 脚本会处理 Node 检测、安装和新手引导。

    如果要跳过新手引导，只安装二进制文件：

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

    所有标志、环境变量以及 CI/自动化选项，请参阅 [Installer internals](/install/installer)。

  </Accordion>

  <Accordion title="npm / pnpm" icon="package">
    如果你已经自行管理 Node，我们推荐使用 Node 24。出于兼容性考虑，OpenClaw 仍支持 Node 22 LTS，目前为 `22.16+`：

    <Tabs>
      <Tab title="npm">
        ```bash
        npm install -g openclaw@latest
        openclaw onboard --install-daemon
        ```

        <Accordion title="sharp 构建错误？">
          如果你全局安装了 libvips（在 macOS 上通过 Homebrew 很常见），并且 `sharp` 失败，请强制使用预构建二进制文件：

          ```bash
          SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g openclaw@latest
          ```

          如果你看到 `sharp: Please add node-gyp to your dependencies`，请安装构建工具链（macOS：Xcode CLT + `npm install -g node-gyp`），或者使用上面的环境变量。
        </Accordion>
      </Tab>
      <Tab title="pnpm">
        ```bash
        pnpm add -g openclaw@latest
        pnpm approve-builds -g        # 批准 openclaw、node-llama-cpp、sharp 等
        openclaw onboard --install-daemon
        ```

        <Note>
        `pnpm` 要求对带有构建脚本的包进行显式批准。首次安装出现 “Ignored build scripts” 警告后，运行 `pnpm approve-builds -g` 并选择列出的包。
        </Note>
      </Tab>
    </Tabs>

    想通过包管理器安装当前 GitHub `main` 分支最新版本？

    ```bash
    npm install -g github:openclaw/openclaw#main
    ```

    ```bash
    pnpm add -g github:openclaw/openclaw#main
    ```

  </Accordion>

  <Accordion title="从源码" icon="github">
    适用于贡献者或任何想从本地检出运行的人。

    <Steps>
      <Step title="克隆并构建">
        克隆 [OpenClaw 仓库](https://github.com/openclaw/openclaw) 并构建：

        ```bash
        git clone https://github.com/openclaw/openclaw.git
        cd openclaw
        pnpm install
        pnpm ui:build
        pnpm build
        ```
      </Step>
      <Step title="链接 CLI">
        让 `openclaw` 命令在全局可用：

        ```bash
        pnpm link --global
        ```

        或者，你也可以跳过链接，直接在仓库内通过 `pnpm openclaw ...` 运行命令。
      </Step>
      <Step title="运行新手引导">
        ```bash
        openclaw onboard --install-daemon
        ```
      </Step>
    </Steps>

    更深入的开发工作流请参阅 [Setup](/start/setup)。

  </Accordion>
</AccordionGroup>

## 其他安装方法

<CardGroup cols={2}>
  <Card title="Docker" href="/install/docker" icon="container">
    容器化或无头部署。
  </Card>
  <Card title="Podman" href="/install/podman" icon="container">
    无 root 容器：先运行一次 `setup-podman.sh`，然后运行启动脚本。
  </Card>
  <Card title="Nix" href="/install/nix" icon="snowflake">
    通过 Nix 进行声明式安装。
  </Card>
  <Card title="Ansible" href="/install/ansible" icon="server">
    自动化批量配置。
  </Card>
  <Card title="Bun" href="/install/bun" icon="zap">
    通过 Bun 运行时进行仅 CLI 使用。
  </Card>
</CardGroup>

## 安装后

验证一切是否正常工作：

```bash
openclaw doctor         # 检查配置问题
openclaw status         # Gateway 网关状态
openclaw dashboard      # 打开浏览器 UI
```

如果你需要自定义运行时路径，请使用：

- `OPENCLAW_HOME` 用于基于主目录的内部路径
- `OPENCLAW_STATE_DIR` 用于可变状态位置
- `OPENCLAW_CONFIG_PATH` 用于配置文件位置

有关优先级和完整细节，请参阅 [Environment vars](/help/environment)。

## 故障排除：找不到 `openclaw`

<Accordion title="PATH 诊断与修复">
  快速诊断：

```bash
node -v
npm -v
npm prefix -g
echo "$PATH"
```

如果 `$(npm prefix -g)/bin`（macOS/Linux）或 `$(npm prefix -g)`（Windows）**不在**你的 `$PATH` 中，那么你的 shell 就找不到全局 npm 二进制文件（包括 `openclaw`）。

修复方法 —— 将其添加到你的 shell 启动文件（`~/.zshrc` 或 `~/.bashrc`）中：

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
```

在 Windows 上，将 `npm prefix -g` 的输出添加到你的 PATH 中。

然后打开一个新的终端（或者在 zsh 中运行 `rehash`，在 bash 中运行 `hash -r`）。
</Accordion>

## 更新 / 卸载

<CardGroup cols={3}>
  <Card title="更新" href="/install/updating" icon="refresh-cw">
    让 OpenClaw 保持最新。
  </Card>
  <Card title="迁移" href="/install/migrating" icon="arrow-right">
    迁移到新机器。
  </Card>
  <Card title="卸载" href="/install/uninstall" icon="trash-2">
    完全移除 OpenClaw。
  </Card>
</CardGroup>
