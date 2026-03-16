---
read_when:
  - 从零开始进行首次设置
  - 你想用最快的路径开始可用聊天
summary: 在几分钟内安装 OpenClaw 并开始你的第一次聊天。
title: 入门指南
x-i18n:
  generated_at: "2026-03-16T06:27:55Z"
  model: gpt-5.4
  provider: openai
  source_hash: 47583047c1a603c1254d2540846452ad321d12bc7fc3f24e5def9282ee96f415
  source_path: start/getting-started.md
  workflow: 15
---

# 入门指南

目标：以最少的设置，从零开始到完成第一次可用聊天。

<Info>
最快的聊天方式：打开 Control UI（无需设置渠道）。运行 `openclaw dashboard`
并在浏览器中聊天，或在
<Tooltip headline="Gateway host" tip="运行 OpenClaw Gateway 网关服务的机器。">网关主机</Tooltip>
上打开 `http://127.0.0.1:18789/`。
文档：[Dashboard](/web/dashboard) 和 [Control UI](/web/control-ui)。
</Info>

## 前置条件

- 推荐使用 Node 24（Node 22 LTS，目前为 `22.16+`，仍因兼容性而受支持）

<Tip>
如果你不确定，请使用 `node --version` 检查你的 Node 版本。
</Tip>

## 快速设置（CLI）

<Steps>
  <Step title="安装 OpenClaw（推荐）">
    <Tabs>
      <Tab title="macOS/Linux">
        ```bash
        curl -fsSL https://openclaw.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="安装脚本流程"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows（PowerShell）">
        ```powershell
        iwr -useb https://openclaw.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    其他安装方式和要求： [Install](/install)。
    </Note>

  </Step>
  <Step title="运行设置向导">
    ```bash
    openclaw onboard --install-daemon
    ```

    向导会配置认证、Gateway 网关设置和可选渠道。
    详情请参见 [Setup Wizard](/start/wizard)。

  </Step>
  <Step title="检查 Gateway 网关">
    如果你已安装服务，它应该已经在运行：

    ```bash
    openclaw gateway status
    ```

  </Step>
  <Step title="打开 Control UI">
    ```bash
    openclaw dashboard
    ```
  </Step>
</Steps>

<Check>
如果 Control UI 能加载，你的 Gateway 网关就已准备就绪，可以使用。
</Check>

## 可选检查和附加内容

<AccordionGroup>
  <Accordion title="在前台运行 Gateway 网关">
    适合快速测试或故障排除。

    ```bash
    openclaw gateway --port 18789
    ```

  </Accordion>
  <Accordion title="发送一条测试消息">
    需要已配置的渠道。

    ```bash
    openclaw message send --target +15555550123 --message "Hello from OpenClaw"
    ```

  </Accordion>
</AccordionGroup>

## 常用环境变量

如果你将 OpenClaw 作为服务账户运行，或想使用自定义配置/状态位置：

- `OPENCLAW_HOME` 设置用于内部路径解析的主目录。
- `OPENCLAW_STATE_DIR` 覆盖状态目录。
- `OPENCLAW_CONFIG_PATH` 覆盖配置文件路径。

完整的环境变量参考： [环境变量](/help/environment)。

## 深入了解

<Columns>
  <Card title="设置向导（详情）" href="/start/wizard">
    完整的 CLI 向导参考和高级选项。
  </Card>
  <Card title="macOS 应用新手引导" href="/start/onboarding">
    macOS 应用的首次运行流程。
  </Card>
</Columns>

## 你将获得什么

- 一个正在运行的 Gateway 网关
- 已配置好的认证
- Control UI 访问权限或一个已连接的渠道

## 后续步骤

- 私信安全和批准：[Pairing](/channels/pairing)
- 连接更多渠道：[Channels](/channels)
- 高级工作流和源码安装：[Setup](/start/setup)
