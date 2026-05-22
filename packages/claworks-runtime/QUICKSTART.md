# ClaWorks 5 分钟快速启动

## 前提条件

- Node.js 22+
- pnpm
- Ollama（本地模型）或 OpenAI API Key

## 步骤 1：配置环境变量

```bash
cp .env.example .env
# 编辑 .env，至少填写：
# - CLAWORKS_OWNER_USER_ID（你的飞书用户 ID）
# - OLLAMA_BASE_URL 或 OPENAI_API_KEY
```

## 步骤 2：启动 ClaWorks

### 独立模式（推荐，无需 OpenClaw）

```bash
# 在 ClaWorks 项目根目录下
pnpm install
claworks start        # 或 pnpm dev（开发模式）
```

ClaWorks 完全独立运行，状态目录 `~/.claworks`，端口 `18800`，与 OpenClaw 零冲突。

### 增强模式（与 OpenClaw 协作）

```bash
# 在 OpenClaw 项目根目录下（同时安装了 OpenClaw 时）
pnpm install
pnpm dev
```

ClaWorks 作为 OpenClaw 插件加载，可共享 LLM 路由、多渠道发送等能力。

机器人启动时会自动：

1. 扫描环境变量，发现可用服务（飞书 / Ollama / OpenAI）
2. 检测 OpenClaw 配置并同步（模型、技能、渠道）
3. 向你（owner）发送欢迎消息

## 步骤 3：测试机器人

在飞书中向机器人发送消息：

| 消息         | 说明           |
| ------------ | -------------- |
| **帮助**     | 查看所有功能   |
| **你是谁**   | 机器人自我介绍 |
| **健康检查** | 查看系统状态   |
| **扫描环境** | 发现可用服务   |

## 可选：使用 claworks.robot.json 定制机器人

```bash
cp claworks.robot.json.example claworks.robot.json
# 编辑 claworks.robot.json，配置机器人名称、角色、组织等
```

详细字段说明见 `ROBOT.md`。

## 可选：Docker 部署

```bash
# 确保已配置 .env 文件
docker compose up -d
```

服务启动后访问：

- REST API: `http://localhost:3100/v1`
- 健康检查: `http://localhost:3100/healthz`
- Studio UI: `http://localhost:3100/studio`

## 可选：单独启动 ClaWorks Runtime（不依赖 OpenClaw）

如果你想在不启动完整 OpenClaw 的情况下测试运行时：

```bash
cd packages/claworks-runtime
pnpm build
node dist/standalone.js  # 如果存在
```

## 启动调用链说明

```
OpenClaw 启动
  └─ 加载 claworks-robot 插件（extensions/claworks-robot/index.ts）
       └─ createClaworksRuntime(config)
            ├─ loadRobotConfig()               # 加载 claworks.robot.json
            ├─ 初始化 EventKernel / ObjectStore / KB / PlaybookEngine
            └─ startClaworksRuntime()
                 ├─ 启动 Kernel、连接器、自主引擎
                 └─ OnboardingManager.startOnboarding()（首次启动）
                      ├─ Step 1: health.check（自检）
                      ├─ Step 2: 身份初始化
                      ├─ Step 3: 发布 system.onboarding_started
                      │    └─ 触发 Playbooks（并行）:
                      │         ├─ environment_discovery.yaml（扫描环境）
                      │         ├─ harness_sync_openclaw.yaml（同步 OpenClaw）
                      │         └─ setup_wizard.yaml（交互式配置向导）
                      ├─ Step 4: KB 预热
                      ├─ Step 5: 注册默认 Hook
                      ├─ Step 6: 向 owner 发送欢迎消息
                      └─ Step 7: 发布 system.ready
```

## 常见问题

**Q: 机器人没有回复**

A: 检查 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 是否正确。运行：

```bash
claworks doctor
```

**Q: 意图识别不准**

A: 更换更强的模型，或在 `claworks.robot.json` 中配置：

```json
{
  "llm": {
    "classification_model": "qwen2.5:14b"
  }
}
```

**Q: 如何添加自定义业务**

A: 在 `claworks-packs/` 目录下创建新的 Pack，参考 `base` Pack 的结构。详见 `ROBOT.md`。

**Q: 如何强制重新执行开箱配置**

A: 设置环境变量 `CLAWORKS_FORCE_ONBOARDING=1` 重启机器人。

---

## ClaWorks 与 OpenClaw 共存

两个产品在同一台机器上完全不冲突：

| 项目     | ClaWorks             | OpenClaw               |
| -------- | -------------------- | ---------------------- |
| CLI 命令 | `claworks`           | `openclaw`             |
| 配置目录 | `~/.claworks/`       | `~/.openclaw/`         |
| 配置文件 | `claworks.json`      | `openclaw.json`        |
| 默认端口 | `18800`              | `18789`                |
| 状态变量 | `CLAWORKS_STATE_DIR` | `OPENCLAW_STATE_DIR`   |
| 配置变量 | `CLAWORKS_CONFIG`    | `OPENCLAW_CONFIG_PATH` |

ClaWorks 从不读写 `~/.openclaw` 目录，除非在增强模式下主动触发同步（`harness_sync_openclaw` Playbook）。
