# fin-backtest-remote

OpenFinClaw 插件：对接远程 Findoo Backtest Agent（fep v1.1），在对话中通过 tools 提交回测、查状态、取报告。

## 调用方式

**可以在前端聊天页面中直接对话调用**，无需单独调 API。

- 前端（Web 聊天、Telegram、Discord 等）发起的对话会进入 OpenClaw Agent；Agent 使用的工具集中包含本插件的 `backtest_remote_validate`、`backtest_remote_submit`、`backtest_remote_status`、`backtest_remote_report`、`backtest_remote_list`、`backtest_remote_cancel`。
- 用户用自然语言即可触发，例如：
  - 「帮我校验一下这个策略包目录」
  - 「把这个策略打包并提交回测」
  - 「查一下回测任务 xxx 的状态」
  - 「获取任务 xxx 的完整报告」
- Agent 会根据语义匹配 **backtest-server**、**strategy-pack** 等 skill，并调用上述工具执行；无需在前端或客户端显式指定工具名或参数（由 Agent 解析对话后调用）。

前提：插件已在配置中启用（`plugins.entries.fin-backtest-remote.enabled: true`），并填好 `config.baseUrl`（及可选 `apiKey`），且当前会话具备 **coding** 工具权限（如 `tools.profile: "coding"`）以便 Agent 能读技能文档、写文件、执行打包命令。详见 [对话中使用策略构建与远程回测 — 配置说明](docs/finance/conversation-strategy-backtest-config.md)。

## 配置 baseUrl 与 apiKey

配置写在 **OpenClaw 主配置** 的 `plugins.entries.fin-backtest-remote` 下，对应本插件的 `config` 与可选 `apiKey`。

### 配置文件位置

- 用户级：`~/.openclaw/config.json`（或当前环境使用的 openclaw 配置）
- 修改后需 **重启 Gateway** 才会生效

### 方式一：直接编辑 JSON

在 `config.json` 的 `plugins.entries` 中增加或修改：

```json
{
  "plugins": {
    "entries": {
      "fin-backtest-remote": {
        "enabled": true,
        "config": {
          "baseUrl": "http://150.109.16.195:8000",
          "apiKey": "bt-sk-xxxxxxxx"
        }
      }
    }
  }
}
```

- **baseUrl**：回测服务根地址，不要末尾斜杠（如 `http://150.109.16.195:8000`）。
- **apiKey**：服务端要求的 `X-API-Key`；本地开发若服务不校验可留空或不写。
- 可选 **requestTimeoutMs**：请求超时毫秒数，默认 60000。

### 方式二：CLI 写入

```bash
# 启用插件
openfinclaw config set plugins.entries.fin-backtest-remote.enabled true

# 设置 baseUrl
openfinclaw config set plugins.entries.fin-backtest-remote.config.baseUrl "http://150.109.16.195:8000"

# 设置 apiKey（敏感信息，勿提交到版本库）
openfinclaw config set plugins.entries.fin-backtest-remote.config.apiKey "bt-sk-xxxxxxxx"
```

### 环境变量（可选）

插件会从环境变量读取，作为未在 `config` 中配置时的回退：

- **BACKTEST_API_KEY**：API Key（与文档一致）
- **BACKTEST_API_BASE_URL** 或 **BACKTEST_BASE_URL**：baseUrl

生产环境建议用配置或密钥管理注入，避免在进程环境中明文暴露。

---

## 策略包生成与校验

- **Skill**：`skills/strategy-pack/SKILL.md` 描述如何按 fep v1.1 生成策略包（目录结构、fep.yaml 最小/完整示例、strategy.py 的 `compute(data)` 与安全限制），以及**上传前必须先校验**的流程。
- **校验**：使用 `backtest_remote_validate`，传入策略包**目录路径**；仅当返回 `valid: true` 后再打包为 ZIP 并调用 `backtest_remote_submit`。
- 校验规则见 [回测Server-fep-v1.1使用指南](docs/finance/回测Server-fep-v1.1使用指南.md) 第 4 节（必要文件、fep 字段、strategy 禁止 import/call）。

## 测试

### 单元测试（推荐）

在仓库根目录执行，只跑本插件用例：

```bash
pnpm exec vitest run extensions/fin-backtest-remote/index.test.ts
```

或跑全量测试时自动包含该文件：

```bash
pnpm test
```

用例覆盖：插件元数据、5 个 tool 注册、config/env 解析、各 tool 在 mock fetch 下的成功/错误返回（含 submit 的 filePath 必填、status 的 task_id 必填、以及 env `BACKTEST_API_KEY` 回退）。

### 手动 / 联调

1. **先确认远程服务可用**（不依赖 OpenClaw）：

   ```bash
   curl http://<baseUrl>/api/v1/health
   # 预期: {"status":"ok"}
   ```

2. **在 OpenClaw 中配置并启用本插件**（见上节），重启 Gateway。

3. **与 agent 对话**：发送“帮我用远程回测跑一下策略”“查一下回测任务状态”等，由 Skill 引导调用 `backtest_remote_*` tools；或通过支持 tool 调用的界面直接触发对应 tool。
