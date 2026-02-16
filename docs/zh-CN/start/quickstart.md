---
read_when:
  - 你希望以最快的方式从安装到运行一个可用的 Gateway 网关
summary: 安装 SmartAgentNeo，完成 Gateway 网关新手引导，并配对你的第一个渠道。
title: 快速开始
x-i18n:
  generated_at: "2026-02-04T17:53:21Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 3c5da65996f89913cd115279ae21dcab794eadd14595951b676d8f7864fbbe2d
  source_path: start/quickstart.md
  workflow: 15
---

<Note>
SmartAgentNeo 需要 Node 22 或更新版本。
</Note>

## 安装

<Tabs>
  <Tab title="npm">
    ```bash
    npm install -g smart-agent-neo@latest
    ```
  </Tab>
  <Tab title="pnpm">
    ```bash
    pnpm add -g smart-agent-neo@latest
    ```
  </Tab>
</Tabs>

## 新手引导并运行 Gateway 网关

<Steps>
  <Step title="新手引导并安装服务">
    ```bash
    smart-agent-neo onboard --install-daemon
    ```
  </Step>
  <Step title="配对 WhatsApp">
    ```bash
    smart-agent-neo channels login
    ```
  </Step>
  <Step title="启动 Gateway 网关">
    ```bash
    smart-agent-neo gateway --port 18789
    ```
  </Step>
</Steps>

完成新手引导后，Gateway 网关将通过用户服务运行。你也可以使用 `smart-agent-neo gateway` 手动启动。

<Info>
之后在 npm 安装和 git 安装之间切换非常简单。安装另一种方式后，运行
`smart-agent-neo doctor` 即可更新 Gateway 网关服务入口点。
</Info>

## 从源码安装（开发）

```bash
git clone https://github.com/betterbrand/smart-agent-neo.git
cd smart-agent-neo
pnpm install
pnpm ui:build # 首次运行时会自动安装 UI 依赖
pnpm build
smart-agent-neo onboard --install-daemon
```

如果你还没有全局安装，可以在仓库目录中通过 `pnpm smart-agent-neo ...` 运行新手引导。

## 多实例快速开始（可选）

```bash
SMART_AGENT_NEO_CONFIG_PATH=~/.smart-agent-neo/a.json \
SMART_AGENT_NEO_STATE_DIR=~/.smart-agent-neo-a \
smart-agent-neo gateway --port 19001
```

## 发送测试消息

需要一个正在运行的 Gateway 网关。

```bash
smart-agent-neo message send --target +15555550123 --message "Hello from SmartAgentNeo"
```
