# 对话中使用策略构建与远程回测 — 配置说明

让用户在与 Agent **对话**时能正常使用 **fin-strategy-builder**（策略构建器）和 **fin-backtest-remote**（远程 Findoo 回测），需同时满足：**工具权限**、**Strategy Builder Skill**、**远程回测插件** 三项配置。

---

## 1. 工具权限（必选）

Agent 需要 **read**、**write**、**edit**、**exec** 才能在工作区生成策略包、执行打包与校验。系统会要求 agent 用 **read** 工具读取技能文档（SKILL.md）；若 agent 报「无法直接读取技能文档」或「文档相关操作工具未生效」，说明当前会话**没有 read 工具**，即工具配置未生效。

在**实际被加载的**配置文件中设置（见下节「配置生效」）：

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["read", "exec", "write", "edit"]
  }
}
```

说明见 [策略生成与 coding-agent 所需工具配置](./strategy-builder-tools-config.md)。

### 1.1 确保配置已生效（尤其通过 Gateway 对话时）

- **生效的配置**：由「进程启动时」的环境与路径决定。未设置 `OPENCLAW_CONFIG_PATH`（或 `OPENFINCLAW_CONFIG_PATH`）时，会按优先级查找：**新路径** `~/.openfinclaw/openfinclaw.json`、**旧路径** `~/.openclaw/openclaw.json` 等。  
  从本仓库当前版本起，`fin-strategy-engine` 插件在对话中通过 `fin_strategy_create` 等工具创建的策略元数据，会统一持久化到 `~/.openfinclaw/strategy/fin-strategies.json`，便于后续集中管理与备份。
- **通过 Gateway 对话**：加载的是 **Gateway 进程**使用的配置。若启动 Gateway 时未设置 `OPENCLAW_CONFIG_PATH`，则不会使用模板里的 `commons/templates/finclaw-starter/openclaw.json`，只会用上述默认路径下的文件。
- **正确做法二选一**：
  1. **用模板当主配置**：启动 Gateway（或 CLI agent）时设置环境变量，例如  
     `OPENCLAW_CONFIG_PATH=D:\code\openFinclaw\commons\templates\finclaw-starter\openclaw.json`  
     并保证进程**当前工作目录为仓库根**（若模板里用了相对路径如 `extraDirs`）。
  2. **修改默认主配置**：在**实际生效的那份**里写入上述 `tools.profile` 与 `tools.alsoAllow`。
     - 若使用**旧路径**：修改 **`~/.openclaw/openclaw.json`**（不存在则新建该文件）。
     - 若使用**新路径**：修改 **`~/.openfinclaw/openfinclaw.json`**。  
       保存后**重启 Gateway**，再试创建策略。
- 修改任意配置后，**必须重启 Gateway** 才会生效。

---

## 2. 策略构建器 Skill（fin-strategy-builder）

**fin-strategy-builder** 负责在对话中根据用户意图生成 FEP v1.1 策略包（fep.yaml + scripts/strategy.py），并引导校验与提交流程。

### 方式 A：Commons 安装（推荐）

在工作区目录执行：

```bash
openclaw commons install fin-strategy-builder
```

（若 commons 将 skill 安装到固定目录，请把该目录配置为 `skills.load.extraDirs` 或确保在 Agent 的 workspace skills 路径下。）

### 方式 B：工作区 skills 目录

若项目使用 `skills.skillsDir: "./skills"` 或默认工作区 `skills/`：

- 将 `fin-strategy-builder` 的 SKILL 放到工作区 `skills/fin-strategy-builder/SKILL.md`，或
- 通过 `skills.load.extraDirs` 指向包含 fin-strategy-builder 的目录。

确保运行 Agent 时加载的 skill 列表中包含 **fin-strategy-builder**（可通过 `openclaw skills status` 等命令确认）。

---

## 3. 远程回测插件（fin-backtest-remote）

**fin-backtest-remote** 提供 `backtest_remote_validate`、`backtest_remote_submit`、`backtest_remote_status`、`backtest_remote_report` 等工具，并随插件加载 **strategy-pack**、**backtest-server** 两个 skill，用于在对话中校验策略包、提交 ZIP、查状态、取报告。

### 3.1 启用插件

在 **OpenClaw 主配置**（旧路径：`~/.openclaw/openclaw.json`；新路径：`~/.openfinclaw/openfinclaw.json`；或当前工作区使用的 config）的 `plugins.entries` 中增加或修改：

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

- **baseUrl**：回测 API 根地址（无末尾斜杠）。
- **apiKey**：服务端要求的 `X-API-Key`；本地开发若服务不校验可留空或省略。

### 3.2 CLI 快速配置

```bash
openclaw config set plugins.entries.fin-backtest-remote.enabled true
openclaw config set plugins.entries.fin-backtest-remote.config.baseUrl "http://150.109.16.195:8000"
openclaw config set plugins.entries.fin-backtest-remote.config.apiKey "bt-sk-xxxxxxxx"
```

修改配置后需 **重启 Gateway**（或重新加载配置）后生效。

### 3.3 插件与 Skill 来源

- 插件需在 OpenClaw 的 **插件注册表** 中（例如在仓库 `extensions/fin-backtest-remote` 中已实现并随运行环境加载）。
- 启用后，插件的 **backtest-server**、**strategy-pack** skill 会自动参与对话的 skill 匹配，无需再单独安装这两个 skill。

---

## 4. 配置检查清单

| 项           | 配置                                                 | 说明                                   |
| ------------ | ---------------------------------------------------- | -------------------------------------- |
| 工具 profile | `tools.profile: "coding"`                            | 保证 read/write/edit/exec 可用         |
| 策略构建器   | fin-strategy-builder 已安装并参与加载                | 对话可触发「创建策略」「生成策略包」等 |
| 远程回测插件 | `plugins.entries.fin-backtest-remote.enabled: true`  | 对话可校验、提交、查回测               |
| 回测服务地址 | `plugins.entries.fin-backtest-remote.config.baseUrl` | 必填（生产/测试环境）                  |
| 回测 API Key | `plugins.entries.fin-backtest-remote.config.apiKey`  | 按服务要求配置，本地免鉴权可留空       |

---

## 5. 本地开发（无需 `commons install`）

若在**仓库内本地开发**，且 `openclaw commons install fin-strategy-builder` 等命令不可用，可直接用 **finclaw-starter 模板** 的配置，从仓库加载 skill，**不依赖 commons 安装**。

### 5.1 使用模板配置（推荐）

模板 **`commons/templates/finclaw-starter/openclaw.json`** 已包含：

- `tools.profile: "coding"`
- `skills.skillsDir: "./skills"` 与 `skills.load.extraDirs: ["skills", "commons/skills"]` — 从仓库的 `skills/`、`commons/skills/` 加载 skill（含 **fin-strategy-builder**）
- `plugins.entries.fin-backtest-remote` 已启用，并设好 `baseUrl`，`apiKey` 为空（本地免鉴权可留空）

**使用方式：**

1. **指定该配置并保证工作目录为仓库根**  
   `extraDirs` 会按**当前工作目录**解析，因此需在仓库根下执行 Agent/Gateway：

   **Windows (PowerShell)：**

   ```powershell
   $env:OPENCLAW_CONFIG_PATH = "D:\code\openFinclaw\commons\templates\finclaw-starter\openclaw.json"
   cd D:\code\openFinclaw
   pnpm openclaw agent
   ```

   **Windows (CMD)：**

   ```cmd
   set OPENCLAW_CONFIG_PATH=D:\code\openFinclaw\commons\templates\finclaw-starter\openclaw.json
   cd D:\code\openFinclaw
   pnpm openclaw agent
   ```

   **Linux / macOS：**

   ```bash
   export OPENCLAW_CONFIG_PATH="$PWD/commons/templates/finclaw-starter/openclaw.json"
   cd /path/to/openFinclaw
   pnpm openclaw agent
   ```

2. **（可选）回测 API Key**  
   若远程回测服务需要鉴权，编辑 `commons/templates/finclaw-starter/openclaw.json`，在 `plugins.entries.fin-backtest-remote.config` 中填入 `apiKey`。

3. **Gateway**  
   若通过 Gateway 对话，启动时同样设置 `OPENCLAW_CONFIG_PATH` 指向该模板并让进程的当前工作目录为仓库根。

### 5.2 使用现有主配置时

若希望继续用现有主配置（旧路径：`~/.openclaw/openclaw.json`；新路径：`~/.openfinclaw/openfinclaw.json`），可把以下内容合并进去，并**从仓库根目录**运行 Agent：

- `tools.profile: "coding"`
- `skills.load.extraDirs: ["<仓库根绝对路径>/skills", "<仓库根绝对路径>/commons/skills"]`  
  例如：`["D:/code/openFinclaw/skills", "D:/code/openFinclaw/commons/skills"]`
- `plugins.entries.fin-backtest-remote`（enabled + config）

这样无需执行 `openclaw commons install fin-strategy-builder`，对话中即可使用策略构建与远程回测。

---

## 7. 使用 FinClaw Starter 模板

若通过 `openclaw commons install finclaw-starter --dir <工作区路径>` 安装 **finclaw-starter** 模板：

- 已包含 **tools.profile: "coding"**，满足工具权限。
- 模板 **recommended** 中已包含 **fin-strategy-builder**，安装推荐 skill 后即可在对话中使用策略构建。
- 模板中已预置 **fin-backtest-remote** 的 `plugins.entries` 示例（enabled + baseUrl），只需补全 **apiKey**（或本地留空）并重启 Gateway。

安装推荐 skill 后，在同一工作区运行 Agent 或通过 Gateway 对话即可正常使用策略构建与远程回测流程。

---

## 8. 故障排查：agent 报「无法直接读取技能文档」

- **含义**：系统要求 agent 用 **read** 工具打开 SKILL.md；报错说明当前会话没有 **read** 工具（或文档相关操作工具未生效）。
- **原因**：实际生效的配置里 `tools.profile` 不是 `"coding"`，或未通过 `tools.alsoAllow` 放行 read，导致 read 被过滤掉。
- **处理**：
  1. 确认**生效的配置文件**：若通过 Gateway 对话，看 Gateway 启动时是否设置了 `OPENCLAW_CONFIG_PATH`；未设置则生效的是旧路径 **`~/.openclaw/openclaw.json`** 或新路径 `~/.openfinclaw/openfinclaw.json`（按实际存在的文件）。
  2. 在该**同一份**配置中设置 `tools.profile: "coding"` 与 `tools.alsoAllow: ["read", "exec", "write", "edit"]`（或直接使用模板 `commons/templates/finclaw-starter/openclaw.json` 并让 Gateway 通过 `OPENCLAW_CONFIG_PATH` 加载它）。
  3. 保存后**重启 Gateway**，再发起一次「创建策略」对话。

---

## 9. 参考

- [策略生成与 coding-agent 所需工具配置](./strategy-builder-tools-config.md)
- [回测 Server fep v1.1 使用指南](./回测Server-fep-v1.1使用指南.md)
- 插件说明：`extensions/fin-backtest-remote/README.md`
