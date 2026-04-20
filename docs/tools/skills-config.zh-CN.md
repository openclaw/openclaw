---
summary: "技能配置架构和示例"
read_when:
  - 添加或修改技能配置
  - 调整捆绑允许列表或安装行为
title: "技能配置"
---

# 技能配置

大多数技能加载器/安装配置位于 `~/.openclaw/openclaw.json` 中的 `skills` 下。代理特定的技能可见性位于 `agents.defaults.skills` 和 `agents.list[].skills` 下。

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
      "image-lab": {
        enabled: true,
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // 或纯文本字符串
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

对于内置图像生成/编辑，首选 `agents.defaults.imageGenerationModel` 加上核心 `image_generate` 工具。`skills.entries.*` 仅用于自定义或第三方技能工作流程。

如果你选择特定的图像提供商/模型，还需要配置该提供商的认证/API 密钥。典型示例：`google/*` 的 `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`，`openai/*` 的 `OPENAI_API_KEY`，以及 `fal/*` 的 `FAL_KEY`。

示例：

- 原生 Nano Banana 风格设置：`agents.defaults.imageGenerationModel.primary: "google/gemini-3.1-flash-image-preview"`
- 原生 fal 设置：`agents.defaults.imageGenerationModel.primary: "fal/fal-ai/flux/dev"`

## 代理技能允许列表

当你希望使用相同的机器/工作区技能根，但每个代理有不同的可见技能集时，使用代理配置。

```json5
{
  agents: {
    defaults: {
      skills: ["github", "weather"],
    },
    list: [
      { id: "writer" }, // 继承默认值 -> github, weather
      { id: "docs", skills: ["docs-search"] }, // 替换默认值
      { id: "locked-down", skills: [] }, // 无技能
    ],
  },
}
```

规则：

- `agents.defaults.skills`：省略 `agents.list[].skills` 的代理的共享基线允许列表。
- 省略 `agents.defaults.skills` 以默认不限制技能。
- `agents.list[].skills`：该代理的明确最终技能集；它不与默认值合并。
- `agents.list[].skills: []`：为该代理暴露无技能。

## 字段

- 内置技能根始终包括 `~/.openclaw/skills`、`~/.agents/skills`、`<workspace>/.agents/skills` 和 `<workspace>/skills`。
- `allowBundled`：仅**捆绑**技能的可选允许列表。设置后，只有列表中的捆绑技能合格（托管、代理和工作区技能不受影响）。
- `load.extraDirs`：要扫描的额外技能目录（最低优先级）。
- `load.watch`：监视技能文件夹并刷新技能快照（默认：true）。
- `load.watchDebounceMs`：技能监视事件的去抖动（毫秒）（默认：250）。
- `install.preferBrew`：在可用时偏好 brew 安装程序（默认：true）。
- `install.nodeManager`：节点安装程序偏好（`npm` | `pnpm` | `yarn` | `bun`，默认：npm）。
  这仅影响**技能安装**；Gateway 运行时仍应为 Node（不推荐为 WhatsApp/Telegram 使用 Bun）。
  - `openclaw setup --node-manager` 范围更窄，当前接受 `npm`、`pnpm` 或 `bun`。如果你想要 Yarn 支持的技能安装，请手动设置 `skills.install.nodeManager: "yarn"`。
- `entries.<skillKey>`：每个技能的覆盖。
- `agents.defaults.skills`：省略 `agents.list[].skills` 的代理继承的可选默认技能允许列表。
- `agents.list[].skills`：可选的每个代理最终技能允许列表；明确列表替换继承的默认值而不是合并。

每个技能的字段：

- `enabled`：设置为 `false` 以禁用技能，即使它已捆绑/安装。
- `env`：为代理运行注入的环境变量（仅当尚未设置时）。
- `apiKey`：为声明主要环境变量的技能提供的可选便利。支持纯文本字符串或 SecretRef 对象（`{ source, provider, id }`）。

## 注意

- `entries` 下的键默认映射到技能名称。如果技能定义了 `metadata.openclaw.skillKey`，请改用该键。
- 加载优先级为 `<workspace>/skills` → `<workspace>/.agents/skills` → `~/.agents/skills` → `~/.openclaw/skills` → 捆绑技能 → `skills.load.extraDirs`。
- 当启用监视程序时，技能的更改会在下次代理轮次中被拾取。

### 沙盒技能 + 环境变量

当会话被**沙盒化**时，技能进程在 Docker 内运行。沙盒**不会**继承主机 `process.env`。

使用以下之一：

- `agents.defaults.sandbox.docker.env`（或每个代理的 `agents.list[].sandbox.docker.env`）
- 将环境变量烘焙到你的自定义沙盒镜像中

全局 `env` 和 `skills.entries.<skill>.env/apiKey` 仅适用于**主机**运行。
