---
read_when:
  - 你希望以最快的方式从安装到运行一个可用的 Gateway 网关
summary: 安装 Activi，完成 Gateway 网关新手引导，并配对你的第一个渠道。
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
Activi 需要 Node 22 或更新版本。
</Note>

## 安装

<Tabs>
  <Tab title="npm">
    ```bash
    npm install -g activi@latest
    ```
  </Tab>
  <Tab title="pnpm">
    ```bash
    pnpm add -g activi@latest
    ```
  </Tab>
</Tabs>

## 新手引导并运行 Gateway 网关

<Steps>
  <Step title="新手引导并安装服务">
    ```bash
    activi onboard --install-daemon
    ```
  </Step>
  <Step title="配对 WhatsApp">
    ```bash
    activi channels login
    ```
  </Step>
  <Step title="启动 Gateway 网关">
    ```bash
    activi gateway --port 18789
    ```
  </Step>
</Steps>

完成新手引导后，Gateway 网关将通过用户服务运行。你也可以使用 `activi gateway` 手动启动。

<Info>
之后在 npm 安装和 git 安装之间切换非常简单。安装另一种方式后，运行
`activi doctor` 即可更新 Gateway 网关服务入口点。
</Info>

## 从源码安装（开发）

```bash
git clone https://github.com/activi/activi.git
cd activi
pnpm install
pnpm ui:build # 首次运行时会自动安装 UI 依赖
pnpm build
activi onboard --install-daemon
```

如果你还没有全局安装，可以在仓库目录中通过 `pnpm activi ...` 运行新手引导。

## 多实例快速开始（可选）

```bash
ACTIVI_CONFIG_PATH=~/.activi/a.json \
ACTIVI_STATE_DIR=~/.activi-a \
activi gateway --port 19001
```

## 发送测试消息

需要一个正在运行的 Gateway 网关。

```bash
activi message send --target +15555550123 --message "Hello from Activi"
```
