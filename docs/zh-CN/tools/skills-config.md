---
read_when:
  - 添加或修改技能配置时
  - 调整内置允许列表或安装行为时
summary: 技能配置结构与示例
title: 技能配置
x-i18n:
  generated_at: "2026-02-01T21:42:49Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e265c93da7856887c11abd92b379349181549e1a02164184d61a8d1f6b2feed5
  source_path: tools/skills-config.md
  workflow: 15
---

# 技能配置

所有技能相关配置位于 `~/.openclaw/openclaw.json` 的 `skills` 下。

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun（Gateway 运行时仍为 Node；不推荐 bun）
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## 字段

- `allowBundled`：可选的**内置**技能允许列表。设置后，只有列表中的内置技能可用（托管/工作区技能不受影响）。
- `load.extraDirs`：要扫描的额外技能目录（优先级最低）。
- `load.watch`：监视技能文件夹并刷新技能快照（默认：true）。
- `load.watchDebounceMs`：技能监视器事件的防抖时间（毫秒，默认：250）。
- `install.preferBrew`：可用时优先使用 brew 安装器（默认：true）。
- `install.nodeManager`：Node 安装器偏好（`npm` | `pnpm` | `yarn` | `bun`，默认：npm）。此选项仅影响**技能安装**；Gateway 运行时应仍使用 Node（不推荐在 WhatsApp/Telegram 中使用 Bun）。
- `entries.<skillKey>`：按技能的覆盖配置。

按技能字段：

- `enabled`：设为 `false` 可禁用技能，即使它是内置/已安装的。
- `env`：为智能体运行注入的环境变量（仅在尚未设置时生效）。
- `apiKey`：可选的便捷字段，用于声明了主要环境变量的技能。

## 说明

- `entries` 下的键默认映射到技能名称。如果技能定义了 `metadata.openclaw.skillKey`，请使用该键。
- 启用监视器时，技能的更改会在下一个智能体回合时生效。

### 沙箱化技能与环境变量

当会话处于**沙箱**模式时，技能进程在 Docker 内运行。沙箱**不会**继承主机的 `process.env`。

请使用以下方式之一：

- `agents.defaults.sandbox.docker.env`（或按智能体 `agents.list[].sandbox.docker.env`）
- 将环境变量烘焙到您的自定义沙箱镜像中

全局 `env` 和 `skills.entries.<skill>.env/apiKey` 仅适用于**主机**运行。
