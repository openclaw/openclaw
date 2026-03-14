---
read_when:
  - 添加或修改 Skills 配置
  - 调整内置白名单或安装行为
summary: Skills 配置 schema 和示例
title: Skills 配置
x-i18n:
  generated_at: "2026-02-03T10:10:59Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e265c93da7856887c11abd92b379349181549e1a02164184d61a8d1f6b2feed5
  source_path: tools/skills-config.md
  workflow: 15
---

# Skills 配置

所有 Skills 相关配置都位于 `~/.openclaw/openclaw.json` 中的 `skills` 下。

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
      nodeManager: "npm", // npm | pnpm | yarn | bun（Gateway 网关运行时仍为 Node；不推荐 bun）
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

- `allowBundled`：可选的仅用于**内置** Skills 的白名单。设置后，只有列表中的内置 Skills 才有资格（托管/工作区 Skills 不受影响）。
- `load.extraDirs`：要扫描的附加 Skills 目录（最低优先级）。
- `load.watch`：监视 Skills 文件夹并刷新 Skills 快照（默认：true）。
- `load.watchDebounceMs`：Skills 监视器事件的防抖时间（毫秒）（默认：250）。
- `install.preferBrew`：在可用时优先使用 brew 安装器（默认：true）。
- `install.nodeManager`：node 安装器偏好（`npm` | `pnpm` | `yarn` | `bun`，默认：npm）。这仅影响 **Skills 安装**；Gateway 网关运行时应仍为 Node（不推荐 Bun 用于 WhatsApp/Telegram）。
- `entries.<skillKey>`：单 Skills 覆盖。

单 Skills 字段：

- `enabled`：设置为 `false` 以禁用某个 Skills，即使它是内置/已安装的。
- `env`：为智能体运行注入的环境变量（仅在尚未设置时）。
- `apiKey`：可选的便捷字段，用于声明主环境变量的 Skills。

## 注意事项

- `entries` 下的键默认映射到 Skills 名称。如果 Skills 定义了 `metadata.openclaw.skillKey`，则使用该键。
- 启用监视器后，Skills 的更改会在下一个智能体轮次被获取。

### 沙箱隔离的 Skills + 环境变量

当会话处于**沙箱隔离**状态时，Skills 进程在 Docker 内运行。沙箱**不会**继承宿主机的 `process.env`。

使用以下方式之一：

- `agents.defaults.sandbox.docker.env`（或单智能体的 `agents.list[].sandbox.docker.env`）
- 将环境变量烘焙到你的自定义沙箱镜像中

全局 `env` 和 `skills.entries.<skill>.env/apiKey` 仅适用于**宿主机**运行。
