# DingTalk（钉钉）本地打包与能力验证指南

> 适用于基于当前仓库 `feat/openclaw-dingtalk` 分支（commit `b6cf885` 起）对 `extensions/dingtalk-connector` 的本地完整链路验证。
> 目标：在一台 macOS / Linux 开发机上，打出可运行的 OpenClaw dist，连通钉钉企业内部机器人，完成 Stream 模式下的核心能力（DM / 群聊 / AI Card 流式 / 媒体 / 多账号 / Docs 工具）验证。

---

## 0. 产物与范围

| 维度      | 说明                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| 插件 ID   | `dingtalk-connector`                                                                                             |
| 插件包名  | `@openclaw/dingtalk-connector`                                                                                   |
| 传输模式  | Stream（长连接，无需公网入口）                                                                                   |
| 主要入口  | `extensions/dingtalk-connector/index.ts`（bundled channel entry）                                                |
| 关键目录  | `src/channel.ts`（Stream 连接）、`src/reply-dispatcher.ts`（AI Card 流式）、`src/gateway-methods.ts`（RPC 暴露） |
| 文档      | `docs/channels/dingtalk-connector.md`（面向用户）                                                                |
| 最低 Host | `>=2026.4.10`（见 `package.json` → `openclaw.install.minHostVersion`）                                           |

---

## 1. 前置条件

### 1.1 开发机环境

- Node ≥ 22（本仓库用 `v23.1.0` 验证过）
- pnpm ≥ 10（本仓库用 `10.33.2` 验证过）
- macOS 14 / Ubuntu 22+ / WSL2；首次 `pnpm install` 需要 Xcode CLT 或 `build-essential`（`@discordjs/opus` 等原生依赖会触发 node-gyp 编译）
- 能访问 `api.dingtalk.com`、`registry.npmjs.org`

### 1.2 钉钉侧前置

- **推荐**：手机装钉钉 App + 拥有应用创建权限的账号即可。后续的扫码登录流程会自动创建应用、分配 Client ID / Secret、开启 Stream。
- **手动降级**（扫码不可用时，参见后文「手动 / CI 降级」一节）：在 [钉钉开放平台](https://open-dev.dingtalk.com/) 建「企业内部应用 → 机器人」，记录 Client ID / Secret，开启 Stream，订阅 `im.message.receive`。

---

## 2. 本地打包

### 2.1 安装依赖

```bash
cd /path/to/openclaw
pnpm install
```

首次安装耗时约 3~5 分钟（含 `@discordjs/opus` 原生编译）。再次运行可利用 pnpm store 缓存。

### 2.2 执行完整构建

```bash
pnpm build
```

构建流水线（`scripts/build-all.mjs`）将依次执行：

1. `plugins:assets:build` — 打包 Canvas A2UI 等资源
2. `tsdown` — 编译 `src/` + 所有 `extensions/*`（含 dingtalk-connector）
3. `runtime-postbuild` — 写入插件 metadata / 运行时 alias
4. `build:plugin-sdk:dts` — 生成 plugin SDK 声明
5. `plugins:assets:copy` — 复制静态资产

### 2.3 验证产物

```bash
# dingtalk-connector 编译产物
ls dist/extensions/dingtalk-connector/*.js
# 期望看到：api.js channel-entry.js channel-plugin-api.js contract-api.js
#         index.js runtime-api.js secret-contract-api.js setup-entry.js setup-plugin-api.js

# CLI 可用
node openclaw.mjs --version
# 期望输出：OpenClaw 2026.<...> (<short-sha>)
```

> 提示：如果看到 `duplicate plugin id ... dingtalk-connector` 警告，说明本机全局配置（`~/.openclaw/config.json5`）里把 dingtalk-connector 指向了另一个路径；这会使本次 build 的 bundled 版本被「配置选中版本」覆盖。验证本次构建时建议临时将全局配置改回 `"dingtalk-connector": "bundled"` 或使用独立 `OPENCLAW_HOME`。

---

## 3. 凭证与配置

### 3.1 扫码登录（首选）

```bash
node openclaw.mjs configure --section channels
```

在向导中选择 `dingtalk-connector`，会渲染二维码；钉钉移动端扫码后即可**新建**或**绑定**机器人，CLI 自动轮询并写入凭证到 `$OPENCLAW_HOME/credentials/dingtalk-connector/<accountId>.json`，完成后按提示 `openclaw gateway restart` 生效。实现见 [`tryScanAuthorizeDingtalk`](../../extensions/dingtalk-connector/src/onboarding.ts#L169-L229) 与 [`device-auth.ts`](../../extensions/dingtalk-connector/src/device-auth.ts)。

> 注：`channels login` 命令不适用于本插件（dingtalk-connector 未实现 `auth.login`），扫码流程挤在配置向导里。

### 3.2 多账号

重复运行 `configure --section channels` 即可添加新账号，向导会要求输入 `accountId`（如 `main` / `backup`）。两个启用账号共用同一 `clientId` 时会去重，只留第一个打开 Stream。

### 3.3 手动 / CI 降级

无交互环境（CI、容器、无法扫码）下手写 `config.json5`：

```bash
export DINGTALK_CLIENT_ID="dingxxxxxxxxxxxx"
export DINGTALK_CLIENT_SECRET="********"
```

```json5
{
  channels: {
    "dingtalk-connector": {
      enabled: true,
      clientId: "dingxxxxxxxxxxxx",
      clientSecret: { source: "env", id: "DINGTALK_CLIENT_SECRET" },
      dmPolicy: "open",
      groupPolicy: "allowlist",
      groupAllowFrom: ["cidXXXXX="],
      requireMention: true,
      groupReplyMode: "aicard",
      tools: { docs: true, media: true },
    },
  },
}
```

---

## 4. 启动与基线验证

所有命令均可加 `--home /tmp/openclaw-dingtalk-qa` 指定独立数据目录，避免污染个人配置。

### 4.1 插件装载校验

```bash
node openclaw.mjs plugins list | grep -i dingtalk
# 期望：DingTalk | dingtalk-connector | enabled | <路径> | <版本>
```

### 4.2 凭证连通性（离线 Probe）

```bash
node openclaw.mjs channels probe dingtalk-connector
# 期望：ok=true，返回 botName / unionid
# 失败常见原因：clientId/secret 不匹配、AppSecret 未启用 Stream、网络被阻断
```

Probe 实现见 [`probeDingtalk`](../../extensions/dingtalk-connector/src/probe.ts)，会依次调 `/v1.0/oauth2/accessToken` 与 `/v1.0/contact/users/me`，结果缓存 10 min（错误 1 min）。

### 4.3 启动 gateway

```bash
node openclaw.mjs gateway start
# 或者开发态热重载：
pnpm gateway:watch
```

观察日志关键字：

- `dingtalk-connector: stream client connected` → Stream 建连成功
- `dingtalk-connector: registered gateway methods` → RPC 已挂载
- `duplicate-load warning` → 有多份同 id 插件，需清理

Follow 日志：

```bash
./scripts/clawlog.sh
```

---

## 5. 能力矩阵与验证用例

每个用例给出：**准备 → 操作 → 期望 → 失败排查**。

### 5.1 DM 消息（文本）

- 准备：在钉钉个人会话里搜索机器人，私聊。
- 操作：发送 `你好`。
- 期望：收到机器人文本回复；`~/.openclaw` 日志出现 `im.message.receive` + `dispatch DM`。
- 失败排查：
  - `dmPolicy: "pairing"` 时首次会收到配对码，需
