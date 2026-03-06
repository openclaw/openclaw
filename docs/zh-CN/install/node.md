---
title: "Node.js"
summary: "为 OpenClaw 安装和配置 Node.js —— 版本要求、安装选项和 PATH 故障排除"
read_when:
  - "在安装 OpenClaw 之前需要安装 Node.js"
  - "安装了 OpenClaw 但提示 `openclaw` 命令未找到"
  - "`npm install -g` 因权限或 PATH 问题失败"
---

# Node.js

OpenClaw 需要 **Node 22 或更高版本**。[安装脚本](/install#install-methods) 会自动检测并安装 Node —— 本页面适用于你想自行设置 Node 并确保一切正确配置（版本、PATH、全局安装）的情况。

## 检查你的版本

```bash
node -v
```

如果输出 `v22.x.x` 或更高，说明版本符合要求。如果 Node 未安装或版本过低，请选择下面的安装方法。

## 安装 Node

<Tabs>
  <Tab title="macOS">
    **Homebrew**（推荐）：

    ```bash
    brew install node
    ```

    或从 [nodejs.org](https://nodejs.org/) 下载 macOS 安装程序。

  </Tab>
  <Tab title="Linux">
    **Ubuntu / Debian：**

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```

    **Fedora / RHEL：**

    ```bash
    sudo dnf install nodejs
    ```

    或使用版本管理器（见下文）。

  </Tab>
  <Tab title="Windows">
    **winget**（推荐）：

    ```powershell
    winget install OpenJS.NodeJS.LTS
    ```

    **Chocolatey：**

    ```powershell
    choco install nodejs-lts
    ```

    或从 [nodejs.org](https://nodejs.org/) 下载 Windows 安装程序。

  </Tab>
</Tabs>

<Accordion title="使用版本管理器（nvm、fnm、mise、asdf）">
  版本管理器可以让你轻松切换 Node 版本。常用选项：

- [**fnm**](https://github.com/Schniz/fnm) —— 快速、跨平台
- [**nvm**](https://github.com/nvm-sh/nvm) —— 在 macOS/Linux 上广泛使用
- [**mise**](https://mise.jdx.dev/) —— 多语言支持（Node、Python、Ruby 等）

使用 fnm 的示例：

```bash
fnm install 22
fnm use 22
```

  <Warning>
  请确保你的版本管理器已在 shell 启动文件（`~/.zshrc` 或 `~/.bashrc`）中初始化。如果没有，新终端会话可能找不到 `openclaw` 命令，因为 PATH 不包含 Node 的 bin 目录。
  </Warning>
</Accordion>

## 故障排除

### `openclaw: command not found`

这通常意味着 npm 的全局 bin 目录不在你的 PATH 中。

<Steps>
  <Step title="查找全局 npm 前缀">
    ```bash
    npm prefix -g
    ```
  </Step>
  <Step title="检查是否在 PATH 中">
    ```bash
    echo "$PATH"
    ```

    在输出中查找 `<npm-prefix>/bin`（macOS/Linux）或 `<npm-prefix>`（Windows）。

  </Step>
  <Step title="将其添加到 shell 启动文件">
    <Tabs>
      <Tab title="macOS / Linux">
        添加到 `~/.zshrc` 或 `~/.bashrc`：

        ```bash
        export PATH="$(npm prefix -g)/bin:$PATH"
        ```

        然后打开新终端（或在 zsh 中运行 `rehash`，在 bash 中运行 `hash -r`）。
      </Tab>
      <Tab title="Windows">
        通过“设置” → “系统” → “环境变量”，将 `npm prefix -g` 的输出添加到系统 PATH。
      </Tab>
    </Tabs>

  </Step>
</Steps>

### `npm install -g` 权限错误（Linux）

如果看到 `EACCES` 错误，请将 npm 的全局前缀切换到用户可写的目录：

```bash
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
```

将 `export PATH=...` 这一行添加到 `~/.bashrc` 或 `~/.zshrc` 以使其永久生效。
