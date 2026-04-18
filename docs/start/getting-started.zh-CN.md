---
summary: "在几分钟内安装 OpenClaw 并运行您的第一次聊天。"
read_when:
  - 从零开始首次设置
  - 您想要最快的路径来获得一个正常工作的聊天
title: "入门指南"
---

# 入门指南

安装 OpenClaw，运行引导流程，并与您的 AI 助手聊天 —— 全部在大约 5 分钟内完成。完成后，您将拥有一个运行中的 Gateway、配置好的认证和一个正常工作的聊天会话。

## 您需要什么

- **Node.js** — 推荐 Node 24（也支持 Node 22.14+）
- **来自模型提供商的 API 密钥**（Anthropic、OpenAI、Google 等）—— 引导流程会提示您

<Tip>
使用 `node --version` 检查您的 Node 版本。
**Windows 用户：** 支持原生 Windows 和 WSL2。WSL2 更稳定，推荐用于完整体验。请参阅 [Windows](/platforms/windows)。
需要安装 Node？请参阅 [Node 设置](/install/node)。
</Tip>

## 快速设置

<Steps>
  <Step title="安装 OpenClaw">
    <Tabs>
      <Tab title="macOS / Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="安装脚本流程"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    其他安装方法（Docker、Nix、npm）：[安装](/install)。
    </Note>

  </Step>
  <Step title="运行引导流程">
    ```bash
    openclaw onboard --install-daemon
    ```

    向导将引导您选择模型提供商、设置 API 密钥和配置 Gateway。整个过程大约需要 2 分钟。

    请参阅 [引导流程（CLI）](/start/wizard) 了解完整参考。

  </Step>
  <Step title="验证 Gateway 是否运行">
    ```bash
    openclaw gateway status
    ```

    您应该看到 Gateway 在端口 18789 上监听。

  </Step>
  <Step title="打开仪表板">
    ```bash
    openclaw dashboard
    ```

    这会在您的浏览器中打开控制 UI。如果它加载成功，说明一切正常。

  </Step>
  <Step title="发送您的第一条消息">
    在控制 UI 聊天中输入一条消息，您应该会收到 AI 的回复。

    想在手机上聊天？设置最快的渠道是 [Telegram](/channels/telegram)（只需一个机器人令牌）。请参阅 [渠道](/channels) 了解所有选项。

  </Step>
</Steps>

<Accordion title="高级：挂载自定义 Control UI 构建">
  如果您维护本地化或自定义的仪表板构建，请将 `gateway.controlUi.root` 指向包含您构建的静态资产和 `index.html` 的目录。

```bash
mkdir -p "$HOME/.openclaw/control-ui-custom"
# 将您构建的静态文件复制到该目录。
```

然后设置：

```json
{
  "gateway": {
    "controlUi": {
      "enabled": true,
      "root": "$HOME/.openclaw/control-ui-custom"
    }
  }
}
```

重启 gateway 并重新打开仪表板：

```bash
openclaw gateway restart
openclaw dashboard
```

</Accordion>

## 下一步做什么

<Columns>
  <Card title="连接渠道" href="/channels" icon="message-square">
    Discord、飞书、iMessage、Matrix、Microsoft Teams、Signal、Slack、Telegram、WhatsApp、Zalo 等。
  </Card>
  <Card title="配对和安全" href="/channels/pairing" icon="shield">
    控制谁可以向您的代理发送消息。
  </Card>
  <Card title="配置 Gateway" href="/gateway/configuration" icon="settings">
    模型、工具、沙盒和高级设置。
  </Card>
  <Card title="浏览工具" href="/tools" icon="wrench">
    浏览器、执行、网络搜索、技能和插件。
  </Card>
</Columns>

<Accordion title="高级：环境变量">
  如果您以服务账户运行 OpenClaw 或需要自定义路径：

- `OPENCLAW_HOME` — 内部路径解析的主目录
- `OPENCLAW_STATE_DIR` — 覆盖状态目录
- `OPENCLAW_CONFIG_PATH` — 覆盖配置文件路径

完整参考：[环境变量](/help/environment)。
</Accordion>
