# OpenClaw 安全体系完整实现分析

> 基于源码分析，非官方文档。涵盖 OpenClaw 自带的全部安全机制、实现细节及对应配置项。
> 分析基于 22 个核心安全文件，共计约 8000 行代码、147 个导出项。

---

## 一、命令执行安全（核心防线）

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/infra/exec-approvals.ts` | 1633 | 命令执行审批引擎（核心） |
| `src/agents/bash-tools.exec.ts` | 1636 | exec 工具实现 |
| `src/agents/bash-tools.shared.ts` | 256 | Bash 工具共享函数 |

### 关键函数索引

```
exec-approvals.ts:
├── L65   const DEFAULT_SAFE_BINS          — 默认安全二进制白名单
├── L87   resolveExecApprovalsPath()       — 审批文件路径解析
├── L91   resolveExecApprovalsSocketPath() — Unix socket 路径
├── L183  normalizeExecApprovals()         — 审批配置标准化
├── L221  readExecApprovalsSnapshot()      — 读取审批快照
├── L253  loadExecApprovals()              — 加载审批配置
├── L270  saveExecApprovals()              — 保存审批配置（强制 0o600 权限）
├── L318  resolveExecApprovals()           — 解析最终审批策略
├── L466  resolveCommandResolution()       — 命令解析（PATH 查找）
├── L582  matchAllowlist()                 — 白名单 glob 匹配
├── L1043 analyzeShellCommand()            — Shell 命令深度解析（管道/链式拆分）
├── L1086 analyzeArgvCommand()             — argv 命令解析
├── L1132 normalizeSafeBins()              — 标准化安全二进制列表
├── L1149 isSafeBinUsage()                 — 安全二进制使用检查（含参数路径检测）
├── L1248 evaluateExecAllowlist()          — 白名单评估（单命令）
├── L1405 evaluateShellAllowlist()         — 白名单评估（完整 Shell 命令）
├── L1494 requiresExecApproval()           — 判断是否需要审批
├── L1535 addAllowlistEntry()              — 添加白名单条目
├── L1557 minSecurity()                    — 安全级别比较
├── L1562 maxAsk()                         — 确认模式比较
└── L1569 requestExecApprovalViaSocket()   — 通过 Unix socket 请求审批

bash-tools.exec.ts:
├── L800  createExecTool()                 — 创建 exec 工具（主入口）
└── L1635 const execTool                   — 导出的 exec 工具实例

bash-tools.shared.ts:
├── L12   type BashSandboxConfig           — 沙箱配置类型
├── L19   buildSandboxEnv()                — 构建沙箱环境变量
├── L51   buildDockerExecArgs()            — 构建 docker exec 参数
├── L84   resolveSandboxWorkdir()          — 解析沙箱工作目录
└── L118  killSession()                    — 终止执行会话
```

### 1.1 三级安全模式

| 模式 | 行为 | 配置键 |
|---|---|---|
| `deny`（**默认**） | 拒绝一切命令执行 | `tools.exec.security` |
| `allowlist` | 仅允许白名单中的命令 | 同上 |
| `full` | 允许所有命令（需显式开启） | 同上 |

类型定义：`exec-approvals.ts:L9` — `type ExecSecurity = "deny" | "allowlist" | "full"`

### 1.2 用户确认模式

| 模式 | 行为 | 配置键 |
|---|---|---|
| `off` | 不询问用户 | `tools.exec.ask` |
| `on-miss`（**默认**） | 不在白名单时询问 | 同上 |
| `always` | 每次都询问 | 同上 |

类型定义：`exec-approvals.ts:L10` — `type ExecAsk = "off" | "on-miss" | "always"`

- 审批通过 Unix domain socket 通信（`requestExecApprovalViaSocket()`，L1569），默认 **15 秒**超时
- 超时回退默认为 `deny`
- 支持三种审批决策：`allow-once` / `allow-always` / `deny`（`type ExecApprovalDecision`，L1567）

### 1.3 执行宿主

| 宿主 | 说明 | 配置键 |
|---|---|---|
| `sandbox`（**默认**） | 在 Docker 容器中执行 | `tools.exec.host` |
| `gateway` | 在 gateway 进程所在机器执行 | 同上 |
| `node` | 在远程 node 设备执行 | 同上 |

类型定义：`exec-approvals.ts:L8` — `type ExecHost = "sandbox" | "gateway" | "node"`

### 1.4 Allowlist 白名单

**默认安全二进制**（`DEFAULT_SAFE_BINS`，L65）：

```
jq, grep, cut, sort, uniq, head, tail, tr, wc
```

**白名单内命令的额外限制**（`isSafeBinUsage()`，L1149）：

- 参数包含路径 token（`./`、`../`、`~`、`/`、`C:\`）→ **拒绝**
- 参数指向已存在的真实文件 → **拒绝**
- 必须有 `resolvedPath`（在 PATH 中找到），否则 → **拒绝**

**自定义白名单**：

- 存储位置：`~/.openclaw/exec-approvals.json`（`resolveExecApprovalsPath()`，L87）
- 每个 agent 独立维护（`type ExecApprovalsAgent`，L27）
- 支持 glob 通配符（`matchAllowlist()`，L582）
- 文件权限强制 `0o600`（`saveExecApprovals()`，L270）

**Skill 二进制**：

- `tools.exec.autoAllowSkills`（默认 `false`）— 不自动信任技能声明的二进制

**命令超时**：

- `tools.exec.timeoutSec`（默认 `1800` 秒 = 30 分钟）

### 1.5 Shell 命令深度解析

核心函数：`analyzeShellCommand()`（L1043）

不是简单字符串匹配，而是真正解析 shell 语法。

**阻止的 shell token**：

```
>  <  `  \n  \r  (  )  $()  ||  |&  &  ;
```

- 管道 `|` → 拆分为段，**每段独立验证**
- 链式 `&&` / `||` / `;` → 拆分为链，**每链独立验证**
- 支持单引号、双引号、转义字符、heredoc 解析
- Windows 额外阻止 `^`、`%`、`!`

返回类型 `ExecCommandAnalysis`（L612）包含：segments、chains、dangerousTokens、hasPipe 等分析结果。

### 1.6 环境变量黑名单（宿主执行时）

实现位置：`bash-tools.exec.ts` 中的 `createExecTool()`（L800）

以下环境变量被严格禁止传递：

```
LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT,
DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH,
NODE_OPTIONS, NODE_PATH,
PYTHONPATH, PYTHONHOME,
RUBYLIB, PERL5LIB,
BASH_ENV, ENV, GCONV_PATH, IFS, SSLKEYLOGFILE
```

加上所有 `DYLD_*` 和 `LD_*` 前缀变量。**自定义 PATH 也被严格禁止**（防止二进制劫持）。

> 注意：在 Sandbox 容器中执行时不做此验证（容器本身已隔离）。

---

## 二、Docker 沙箱隔离

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/agents/sandbox/docker.ts` | 448 | Docker 容器操作 |
| `src/agents/sandbox/config.ts` | 173 | 沙箱配置解析 |
| `src/agents/sandbox/context.ts` | 161 | 沙箱上下文管理 |
| `src/agents/sandbox/constants.ts` | 52 | 常量定义 |
| `src/agents/sandbox/types.ts` | 88 | 类型定义 |
| `src/agents/sandbox/manage.ts` | 120 | 容器生命周期管理 |
| `src/config/types.sandbox.ts` | 76 | 沙箱配置 Schema |

### 关键函数索引

```
docker.ts:
├── L27   execDockerRaw()              — 底层 Docker 命令执行
├── L119  execDocker()                 — Docker exec 封装
├── L128  readDockerPort()             — 读取容器端口映射
├── L158  ensureDockerImage()          — 确保镜像存在（按需拉取）
├── L171  dockerContainerState()       — 查询容器状态
├── L217  buildSandboxCreateArgs()     — 构建 docker create 安全参数（核心加固逻辑）
└── L372  ensureSandboxContainer()     — 确保沙箱容器运行（含配置 hash 比较）

config.ts:
├── L26   resolveSandboxScope()        — 解析沙箱范围
├── L39   resolveSandboxDockerConfig() — 解析 Docker 配置（合并默认值）
├── L84   resolveSandboxBrowserConfig()— 解析浏览器沙箱配置
├── L113  resolveSandboxPruneConfig()  — 解析清理策略
└── L126  resolveSandboxConfigForAgent()— 解析 Agent 级沙箱配置

context.ts:
├── L18   resolveSandboxContext()      — 创建完整的沙箱上下文
└── L106  ensureSandboxWorkspaceForSession() — 为会话准备工作空间

manage.ts:
├── L26   listSandboxContainers()      — 列出所有沙箱容器
├── L61   listSandboxBrowsers()        — 列出浏览器沙箱
├── L95   removeSandboxContainer()     — 删除沙箱容器
└── L104  removeSandboxBrowserContainer() — 删除浏览器沙箱

constants.ts:
├── L7    DEFAULT_SANDBOX_IMAGE        — 默认沙箱镜像
├── L13   DEFAULT_TOOL_ALLOW           — 沙箱内默认允许的工具
└── L29   DEFAULT_TOOL_DENY            — 沙箱内默认拒绝的工具
```

### 2.1 容器安全加固

核心构建逻辑：`buildSandboxCreateArgs()`（docker.ts:L217）

| 措施 | 默认值 | 配置键 |
|---|---|---|
| 只读根文件系统 | `true` | `sandbox.docker.readOnlyRoot` |
| 网络 | `"none"` | `sandbox.docker.network` |
| Capabilities | `["ALL"]`（全部丢弃） | `sandbox.docker.capDrop` |
| 禁止提权 | 始终启用 | 硬编码 `--security-opt no-new-privileges` |
| tmpfs | `/tmp, /var/tmp, /run` | `sandbox.docker.tmpfs` |
| Seccomp | 可选 | `sandbox.docker.seccompProfile` |
| AppArmor | 可选 | `sandbox.docker.apparmorProfile` |
| PID 限制 | 可选 | `sandbox.docker.pidsLimit` |
| 内存限制 | 可选 | `sandbox.docker.memory` / `memorySwap` |
| CPU 限制 | 可选 | `sandbox.docker.cpus` |
| DNS | 可选 | `sandbox.docker.dns` |
| 额外挂载 | 可选 | `sandbox.docker.binds` |

配置类型定义：`types.sandbox.ts:L1` — `type SandboxDockerSettings`

### 2.2 工作空间访问

| 模式 | 行为 | 配置键 |
|---|---|---|
| `none`（**默认**） | 不挂载宿主目录 | `sandbox.workspaceAccess` |
| `ro` | 只读挂载 | 同上 |
| `rw` | 读写挂载 | 同上 |

类型定义：`types.ts:L29` — `type SandboxWorkspaceAccess = "none" | "ro" | "rw"`

### 2.3 沙箱模式和范围

**模式**（`sandbox.mode`）：

| 模式 | 含义 |
|---|---|
| `off`（**默认**） | 不启用沙箱 |
| `non-main` | 仅非主 agent 用沙箱 |
| `all` | 所有 agent 都用沙箱 |

**范围**（`sandbox.scope`，由 `resolveSandboxScope()` 解析，config.ts:L26）：

| 范围 | 含义 |
|---|---|
| `session` | 每个会话独立容器 |
| `agent`（**默认**） | 每个 agent 一个容器 |
| `shared` | 所有 agent 共享容器 |

类型定义：`types.ts:L50` — `type SandboxScope = "session" | "agent" | "shared"`

容器会做**配置 hash 比较**（`ensureSandboxContainer()`，docker.ts:L372），配置变更且不在 hot window（5 分钟）内 → 自动重建容器。

---

## 三、路径安全

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/agents/sandbox-paths.ts` | 118 | 路径沙箱检查 |

### 关键函数索引

```
sandbox-paths.ts:
├── L33  resolveSandboxPath()          — 解析并验证沙箱路径（Unicode 规范化 + 相对路径检查）
├── L49  assertSandboxPath()           — 断言路径在沙箱内（含 symlink 逐段检查）
├── L55  assertMediaNotDataUrl()       — 拒绝 data: URI
└── L62  resolveSandboxedMediaSource() — 安全解析媒体资源路径
```

- **路径逃逸检测**（`resolveSandboxPath()`，L33）：`path.relative()` 后以 `..` 开头或是绝对路径 → 抛错
- **符号链接检测**（`assertSandboxPath()`，L49）：逐段 `lstat` 检查，发现 symlink → 抛错（防止 symlink 逃逸到沙箱外）
- **data: URL 拒绝**（`assertMediaNotDataUrl()`，L55）：媒体路径不接受 `data:` URI
- **Unicode 空格规范化**：防止 Unicode 字符绕过路径检查

---

## 四、工具策略系统

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/agents/pi-tools.policy.ts` | 340 | 全局工具策略引擎 |
| `src/agents/tool-policy.ts` | 292 | 工具策略基础设施（Profile/分组/展开） |
| `src/agents/sandbox/tool-policy.ts` | 143 | 沙箱内工具策略 |

### 关键函数索引

```
pi-tools.policy.ts:
├── L98   resolveSubagentToolPolicy()    — 解析子 Agent 工具策略
├── L108  isToolAllowedByPolicyName()    — 按策略名判断工具是否允许
├── L115  filterToolsByPolicy()          — 按策略过滤工具列表
├── L230  resolveEffectiveToolPolicy()   — 解析最终有效策略（合并全局/Agent/Provider）
├── L275  resolveGroupToolPolicy()       — 解析分组工具策略
└── L334  isToolAllowedByPolicies()      — 多策略叠加判断

tool-policy.ts:
├── L15   const TOOL_GROUPS              — 工具分组定义
├── L82   normalizeToolName()            — 工具名标准化
├── L87   isOwnerOnlyToolName()          — 判断是否 owner-only 工具
├── L91   applyOwnerOnlyToolPolicy()     — 应用 owner-only 策略
├── L135  expandToolGroups()             — 展开工具分组为具体工具列表
├── L168  buildPluginToolGroups()        — 构建插件工具分组
├── L217  expandPolicyWithPluginGroups() — 展开含插件分组的策略
└── L276  resolveToolProfilePolicy()     — 按 Profile 解析策略

sandbox/tool-policy.ts:
├── L58   isToolAllowed()                — 判断沙箱内工具是否允许（deny 优先）
└── L71   resolveSandboxToolPolicyForAgent() — 解析 Agent 沙箱工具策略
```

### 4.1 全局工具策略

| 配置键 | 说明 |
|---|---|
| `tools.profile` | 预设 profile |
| `tools.allow` | 全局允许列表 |
| `tools.alsoAllow` | 附加允许 |
| `tools.deny` | 全局拒绝列表 |
| `tools.byProvider.<provider>` | 按 provider/model 覆盖 |
| `tools.subagents.tools.deny` | 子 agent 拒绝列表 |

### 4.2 工具 Profile 预设

由 `resolveToolProfilePolicy()`（tool-policy.ts:L276）解析：

| Profile | 允许的工具 |
|---|---|
| `minimal` | session_status |
| `coding` | group:fs, group:runtime, group:sessions, group:memory, image |
| `messaging` | group:messaging, sessions 系列, session_status |
| `full` | 全部工具 |

类型定义：`tool-policy.ts:L3` — `type ToolProfileId`

### 4.3 工具分组（Tool Groups）

定义位置：`TOOL_GROUPS`（tool-policy.ts:L15）

```
group:memory      — 记忆读写
group:web         — 网页浏览
group:fs          — 文件系统操作
group:runtime     — 命令执行
group:sessions    — 会话管理
group:ui          — UI 交互
group:automation  — 自动化
group:messaging   — 消息发送
group:nodes       — 节点管理
group:openclaw    — OpenClaw 自身
```

### 4.4 Sandbox 工具策略

默认值定义位置：`constants.ts:L13`（`DEFAULT_TOOL_ALLOW`）和 `L29`（`DEFAULT_TOOL_DENY`）

| 默认允许 | 默认拒绝 |
|---|---|
| exec, process, read, write, edit, apply_patch, image, sessions_* | browser, canvas, nodes, cron, gateway, 所有频道工具 |

- `image` 工具始终自动加入 allow（除非显式 deny）
- **deny 优先于 allow**（`isToolAllowed()`，sandbox/tool-policy.ts:L58）
- 支持 glob 通配符匹配

### 4.5 子 Agent 默认拒绝的工具

由 `resolveSubagentToolPolicy()`（pi-tools.policy.ts:L98）处理：

```
sessions_list, sessions_history, sessions_send, sessions_spawn,
gateway, agents_list, whatsapp_login, session_status, cron,
memory_search, memory_get
```

### 4.6 Owner-only 工具

由 `isOwnerOnlyToolName()`（tool-policy.ts:L87）判断：

`whatsapp_login` — 非 owner 身份不可调用。

---

## 五、提权（Elevated）控制

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/auto-reply/reply/reply-elevated.ts` | 234 | 提权权限判断 |
| `src/agents/bash-tools.exec.ts` | 1636 | 提权执行入口 |

### 关键函数索引

```
reply-elevated.ts:
├── L134  resolveElevatedPermissions()       — 解析提权权限（全局+Agent 级）
└── L206  formatElevatedUnavailableMessage() — 格式化提权不可用的 fix-it 消息
```

### 5.1 两级门控

由 `resolveElevatedPermissions()`（L134）实现：

1. **全局**：`tools.elevated.enabled`（默认 `true`）+ `tools.elevated.allowFrom` 必须匹配 sender
2. **Agent 级**：`agents.list[].tools.elevated.enabled` + 可选 `allowFrom`

未授权时 → `formatElevatedUnavailableMessage()`（L206）抛出包含配置键名的详细 fix-it 错误。

### 5.2 Sender 匹配逻辑

- 支持 `*` 通配符
- 对比字段：SenderName, SenderUsername, SenderTag, SenderE164, From, To
- 去除 channel 前缀后比较
- 大小写不敏感 + slug 化

### 5.3 Elevated Level

类型定义：`bash-tools.exec.ts:L189` — `type ExecElevatedDefaults`

| 级别 | 行为 |
|---|---|
| `off` | 禁用提权 |
| `on` / `ask` | 需要用户审批 |
| `full` | 绕过审批，直接在 gateway 执行 |

---

## 六、SSRF 防护

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/infra/net/fetch-guard.ts` | 175 | SSRF 防护的 fetch 封装 |

### 关键函数索引

```
fetch-guard.ts:
├── L14  type GuardedFetchOptions  — 防护 fetch 选项
├── L27  type GuardedFetchResult   — 防护 fetch 结果
└── L73  fetchWithSsrFGuard()      — 带 SSRF 防护的 fetch（核心入口）
```

- **仅允许 http/https 协议**
- **DNS pinning**（`fetchWithSsrFGuard()`，L73）：解析并固定 IP，防止 DNS rebinding 攻击
- **手动重定向追踪**：最多 3 次，带循环检测
- **超时控制**
- 被拦截时记录安全审计日志（`SsrFBlockedError`）

---

## 七、外部内容注入防护

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/security/external-content.ts` | 300 | 外部内容安全处理 |

### 关键函数索引

```
external-content.ts:
├── L33   detectSuspiciousPatterns()   — 检测可疑注入模式（返回匹配列表）
├── L196  wrapExternalContent()        — 用安全边界包裹外部内容
├── L227  buildSafeExternalPrompt()    — 构建安全的外部内容 prompt
├── L264  isExternalHookSession()      — 判断是否外部 hook 会话
├── L275  getHookType()                — 获取 hook 类型
└── L292  wrapWebContent()             — 包裹网页内容
```

### 7.1 检测的注入模式

由 `detectSuspiciousPatterns()`（L33）实现，匹配以下模式：

```
"ignore all previous instructions"
"disregard all previous"
"forget everything/your instructions"
"you are now a/an"
"new instructions:"
"system: prompt/override/command"
exec.*command=
elevated=true
rm -rf
"delete all emails/files/data"
</system> 标签注入
][system/assistant/user]: 角色切换
```

### 7.2 安全包装

由 `wrapExternalContent()`（L196）实现：

不可信外部内容被包裹在 `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` 边界标记中，前置安全警告告知 LLM 不要执行其中的指令。

类型定义：`L66` — `type ExternalContentSource`（区分 email/webhook/web/file 等来源）

### 7.3 Marker 对抗

外部内容如果本身包含 boundary marker（含 Unicode 全角变体、CJK 角括号等同形字符），会被替换为 `[[MARKER_SANITIZED]]`，防止边界逃逸。

---

## 八、Skill/插件代码扫描

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/security/skill-scanner.ts` | 433 | Skill/插件安全扫描器 |

### 关键函数索引

```
skill-scanner.ts:
├── L52   isScannable()                  — 判断文件是否可扫描
├── L150  scanSource()                   — 扫描单个源文件（行级+源码级规则）
├── L386  scanDirectory()                — 扫描整个目录
└── L406  scanDirectoryWithSummary()     — 扫描目录并生成摘要报告
```

### 8.1 行级扫描规则

在 `scanSource()`（L150）中实现：

| 规则 | 严重性 | 检测内容 |
|---|---|---|
| `dangerous-exec` | **critical** | exec/execSync/spawn/spawnSync + child_process |
| `dynamic-code-execution` | **critical** | eval() / new Function() |
| `crypto-mining` | **critical** | stratum+tcp, coinhive, cryptonight, xmrig |
| `suspicious-network` | warn | WebSocket 非标准端口 |

### 8.2 源码级扫描规则

同样在 `scanSource()`（L150）中实现：

| 规则 | 严重性 | 检测内容 |
|---|---|---|
| `potential-exfiltration` | warn | readFile + fetch/post/http.request 组合 |
| `obfuscated-code` | warn | 连续 6+ hex 编码 / 大段 base64 |
| `env-harvesting` | **critical** | process.env + 网络请求组合 |

类型定义：`L9` — `type SkillScanSeverity`，`L11` — `type SkillScanFinding`

### 8.3 扫描限制

由 `scanDirectory()`（L386）控制：

- 最多扫描 **500 个文件**
- 单文件最大 **1MB**
- 跳过 `node_modules` 和 `.` 开头的目录

---

## 九、安全审计系统

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/security/audit.ts` | 1053 | 全面安全审计引擎 |

### 关键函数索引

```
audit.ts:
└── L971  runSecurityAudit()    — 执行完整安全审计（唯一入口，约 80 行调度逻辑）
```

类型定义：
- `L39` — `type SecurityAuditSeverity = "critical" | "warn" | "info"`
- `L41` — `type SecurityAuditFinding`（单条发现）
- `L55` — `type SecurityAuditReport`（完整报告）
- `L70` — `type SecurityAuditOptions`（审计选项，含 deep 模式开关）

### 9.1 审计检查项

以下检查均在 `runSecurityAudit()`（L971）内部的辅助函数中实现：

#### 网关安全

| checkId | 严重性 | 触发条件 |
|---|---|---|
| `gateway.bind_no_auth` | **critical** | 非 loopback 绑定 + 无认证 |
| `gateway.loopback_no_auth` | **critical** | loopback 绑定 + 无 auth secret |
| `gateway.tailscale_funnel` | **critical** | funnel 模式（公网暴露） |
| `gateway.token_too_short` | warn | token 长度 < 24 字符 |
| `gateway.auth_no_rate_limit` | warn | 非 loopback 无速率限制 |
| `gateway.control_ui.insecure_auth` | **critical** | 允许 HTTP 明文认证 |
| `gateway.control_ui.device_auth_disabled` | **critical** | 设备认证被禁用 |

#### 浏览器安全

| checkId | 严重性 | 触发条件 |
|---|---|---|
| `browser.control_no_auth` | **critical** | 浏览器控制无认证 |
| `browser.remote_cdp_http` | warn | 远程 CDP 使用 HTTP |

#### 文件系统安全

| checkId | 严重性 | 触发条件 |
|---|---|---|
| `fs.state_dir.perms_world_writable` | **critical** | 状态目录 world-writable |
| `fs.state_dir.perms_group_writable` | warn | 状态目录 group-writable |
| `fs.config.perms_writable` | **critical** | 配置文件可被他人写入 |
| `fs.config.perms_world_readable` | **critical** | 配置文件 world-readable |

#### 提权安全

| checkId | 严重性 | 触发条件 |
|---|---|---|
| `tools.elevated.allowFrom.*.wildcard` | **critical** | allowFrom 含 `*` 通配 |
| `tools.elevated.allowFrom.*.large` | warn | allowFrom 超过 25 条 |

#### 其他

| checkId | 严重性 | 触发条件 |
|---|---|---|
| `logging.redact_off` | warn | 日志脱敏被关闭 |
| 频道相关多项 | 不等 | Discord/Slack/Telegram DM 策略、allowlist 等 |

### 9.2 深度检查

当 `SecurityAuditOptions.deep = true` 时，额外执行：
- Gateway WebSocket 探测（检测实际可达性）
- 已安装插件代码扫描（调用 `scanDirectory()`）
- 已安装 skill 代码扫描（调用 `scanDirectoryWithSummary()`）

---

## 十、Node 命令策略

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/gateway/node-command-policy.ts` | 181 | Node 设备命令过滤 |

### 关键函数索引

```
node-command-policy.ts:
├── L53   const DEFAULT_DANGEROUS_NODE_COMMANDS — 默认危险命令列表
├── L142  resolveNodeCommandAllowlist()         — 解析最终允许的命令列表
└── L160  isNodeCommandAllowed()                — 判断命令是否允许（三重检查）
```

### 10.1 平台默认允许命令

| 平台 | 允许的命令 |
|---|---|
| iOS / Android | canvas.*, camera.list, location.get, device.*, contacts.search, calendar.events, reminders.list, photos.latest, motion.*, system.notify |
| macOS | 上述全部 + system.run, system.which, system.execApprovals.*, browser.proxy |
| Linux / Windows | system.run, system.which, system.notify, system.execApprovals.*, browser.proxy |

### 10.2 默认危险命令（需显式允许）

`DEFAULT_DANGEROUS_NODE_COMMANDS`（L53）：

```
camera.snap, camera.clip, screen.record,
contacts.add, calendar.add, reminders.add, sms.send
```

### 10.3 配置

- `gateway.nodes.allowCommands` — 额外允许的命令
- `gateway.nodes.denyCommands` — 额外拒绝的命令

### 10.4 三重检查逻辑

由 `isNodeCommandAllowed()`（L160）实现：

1. 命令在 gateway 的 allowlist 中（`resolveNodeCommandAllowlist()`，L142）
2. 命令在 node 声明的 commands 列表中
3. node 必须声明了 commands（未声明 = 全部拒绝）

---

## 十一、其他安全机制

### 源码文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/agents/session-tool-result-guard.ts` | 249 | 工具结果大小限制 |
| `src/agents/context-window-guard.ts` | 75 | 上下文窗口保护 |

### 关键函数索引

```
session-tool-result-guard.ts:
└── L113  installSessionToolResultGuard()  — 安装工具结果大小守卫

context-window-guard.ts:
├── L3    const CONTEXT_WINDOW_HARD_MIN_TOKENS   — 硬性最小 token 数（16K）
├── L4    const CONTEXT_WINDOW_WARN_BELOW_TOKENS — 警告阈值（32K）
├── L21   resolveContextWindowInfo()              — 解析上下文窗口信息
└── L57   evaluateContextWindowGuard()            — 评估上下文窗口状态
```

| 机制 | 函数 | 说明 |
|---|---|---|
| 工具结果大小限制 | `installSessionToolResultGuard()` | 超过 `HARD_MAX_TOOL_RESULT_CHARS` 时截断，防上下文溢出 |
| 上下文窗口保护 | `evaluateContextWindowGuard()` | < 16K → block，< 32K → warn |
| Gateway 认证 | — | token/password + 速率限制（默认 10 次/60 秒，锁定 5 分钟） |
| TLS 支持 | — | 可选配置证书 / 自签名 |
| 日志脱敏 | — | `logging.redactSensitive` 默认开启 |
| 审批转发 | — | 审批消息可转发到指定频道/会话 |

---

## 十二、配置全景图

以下是 `openclaw.json` 中所有安全相关的配置项及其层级关系：

```
openclaw.json
│
├── gateway
│   ├── bind: "loopback"                             # 绑定地址（loopback/tailscale/0.0.0.0）
│   ├── auth
│   │   ├── mode: "token"                            # 认证模式
│   │   ├── token: "..."                             # 认证令牌
│   │   └── rateLimit                                # 速率限制（次数/窗口/锁定时间）
│   ├── controlUi
│   │   ├── allowInsecureAuth: false                 # 是否允许 HTTP 明文认证
│   │   └── dangerouslyDisableDeviceAuth: false      # 是否禁用设备认证
│   ├── tailscale
│   │   └── mode: "off"                              # Tailscale 暴露模式
│   ├── nodes
│   │   ├── allowCommands: []                        # 额外允许的 node 命令
│   │   └── denyCommands: []                         # 拒绝的 node 命令
│   └── tls                                          # TLS 证书配置
│
├── tools
│   ├── profile: "full"                              # 工具预设（minimal/coding/messaging/full）
│   ├── allow: []                                    # 全局允许工具
│   ├── alsoAllow: []                                # 附加允许工具
│   ├── deny: []                                     # 全局拒绝工具
│   ├── byProvider
│   │   └── <provider>                               # 按 provider/model 覆盖策略
│   ├── elevated
│   │   ├── enabled: true                            # 提权总开关
│   │   └── allowFrom: []                            # 允许提权的 sender 列表
│   ├── exec
│   │   ├── host: "sandbox"                          # 执行宿主（sandbox/gateway/node）
│   │   ├── security: "deny"                         # 安全级别（deny/allowlist/full）
│   │   ├── ask: "on-miss"                           # 确认模式（off/on-miss/always）
│   │   ├── safeBins: [...]                          # 安全二进制列表
│   │   ├── autoAllowSkills: false                   # 是否自动信任技能二进制
│   │   └── timeoutSec: 1800                         # 命令执行超时（秒）
│   ├── subagents
│   │   └── tools.deny: [...]                        # 子 agent 拒绝的工具
│   └── sandbox
│       └── tools
│           ├── allow: [...]                          # Sandbox 允许的工具
│           └── deny: [...]                           # Sandbox 拒绝的工具
│
├── agents
│   ├── defaults
│   │   └── sandbox
│   │       ├── mode: "off"                          # 沙箱模式（off/non-main/all）
│   │       ├── scope: "agent"                       # 容器范围（session/agent/shared）
│   │       ├── workspaceAccess: "none"              # 工作空间访问（none/ro/rw）
│   │       ├── docker
│   │       │   ├── readOnlyRoot: true               # 只读根文件系统
│   │       │   ├── network: "none"                  # 网络隔离
│   │       │   ├── capDrop: ["ALL"]                 # 丢弃所有 Linux Capabilities
│   │       │   ├── seccompProfile: null             # Seccomp 策略
│   │       │   ├── apparmorProfile: null            # AppArmor 策略
│   │       │   ├── pidsLimit: null                  # PID 数量限制
│   │       │   ├── memory: null                     # 内存限制
│   │       │   ├── memorySwap: null                 # Swap 限制
│   │       │   ├── cpus: null                       # CPU 限制
│   │       │   ├── dns: null                        # DNS 配置
│   │       │   └── binds: []                        # 额外挂载
│   │       └── browser
│   │           └── allowHostControl: false           # 浏览器控制
│   └── list[]
│       └── tools
│           ├── elevated
│           │   ├── enabled                           # Agent 级提权开关
│           │   └── allowFrom                         # Agent 级提权白名单
│           ├── exec                                  # Agent 级 exec 配置（同上）
│           └── sandbox.tools                         # Agent 级沙箱工具策略
│
├── logging
│   └── redactSensitive: true                        # 日志脱敏开关
│
└── approvals
    └── exec
        ├── enabled: false                           # 审批转发开关
        ├── mode: "..."                              # 审批模式
        └── targets: []                              # 转发目标（频道/会话）
```

---

## 十三、`rm -rf /` 的完整防御路径

以默认配置为例，一个 `rm -rf /` 命令会经历以下拦截链：

```
LLM 模型生成 tool_call: exec("rm -rf /")
        │
        ▼
[1] 工具策略检查 ─── isToolAllowedByPolicies() → exec 在 allow 列表中？
        │                  （默认允许 → 通过）
        ▼
[2] 安全模式检查 ─── resolveExecApprovals() → security = "deny"
        │                  → 直接拒绝 ✘ （到此结束）
        │
        │  （假设配置为 allowlist）
        ▼
[3] 白名单检查 ──── evaluateShellAllowlist() → "rm" 不在 DEFAULT_SAFE_BINS 中
        │                  → 拒绝 ✘
        │
        │  （假设 rm 被加入白名单）
        ▼
[4] 参数检查 ───── isSafeBinUsage() → "-rf /" 包含绝对路径 "/"
        │                  → 拒绝 ✘
        │
        │  （假设配置为 full）
        ▼
[5] 用户审批 ──── requestExecApprovalViaSocket() → ask = "on-miss" → 需用户确认
        │                  用户看到 "rm -rf /" → 拒绝 ✘
        │
        │  （假设 ask = "off"）
        ▼
[6] 执行宿主 ──── ensureSandboxContainer() → host = "sandbox" → Docker 中执行
        │                  buildSandboxCreateArgs() → 只读 FS + 无网络 + 全 cap drop
        │                  → 容器内 rm -rf / 无法破坏宿主
        │
        │  （假设 host = "gateway" 直接宿主执行）
        ▼
[7] 环境变量保护 ── createExecTool() 中检查 → 不允许 LD_PRELOAD 等注入
        │
        ▼
[8] 路径沙箱 ──── resolveSandboxPath() → "/" 是绝对路径 → 可能被路径检查拦截
        │
        ▼
[9] 安全审计 ──── runSecurityAudit() → 事后记录到审计日志
```

**在默认配置下，第 [2] 步就已经终结**。需要用户主动修改至少 3 层配置才能让危险命令有机会执行。

---

## 十四、完整源码文件清单

| # | 文件路径 | 行数 | 安全职责 |
|---|---|---|---|
| 1 | `src/infra/exec-approvals.ts` | 1633 | 命令执行审批引擎 |
| 2 | `src/agents/bash-tools.exec.ts` | 1636 | exec 工具实现 + 环境变量保护 |
| 3 | `src/agents/bash-tools.shared.ts` | 256 | Bash 工具共享（Docker exec 构建） |
| 4 | `src/agents/sandbox/docker.ts` | 448 | Docker 容器操作 + 安全参数构建 |
| 5 | `src/agents/sandbox/config.ts` | 173 | 沙箱配置解析 |
| 6 | `src/agents/sandbox/context.ts` | 161 | 沙箱上下文（容器+工作空间） |
| 7 | `src/agents/sandbox/constants.ts` | 52 | 沙箱常量（默认镜像/工具策略） |
| 8 | `src/agents/sandbox/types.ts` | 88 | 沙箱类型定义 |
| 9 | `src/agents/sandbox/tool-policy.ts` | 143 | 沙箱内工具 allow/deny |
| 10 | `src/agents/sandbox/manage.ts` | 120 | 容器生命周期管理 |
| 11 | `src/agents/sandbox-paths.ts` | 118 | 路径沙箱（逃逸/symlink 检测） |
| 12 | `src/agents/pi-tools.policy.ts` | 340 | 全局工具策略引擎 |
| 13 | `src/agents/tool-policy.ts` | 292 | 工具 Profile/分组/展开 |
| 14 | `src/security/audit.ts` | 1053 | 安全审计（20+ 项检查） |
| 15 | `src/security/skill-scanner.ts` | 433 | Skill/插件代码扫描 |
| 16 | `src/security/external-content.ts` | 300 | 外部内容注入防护 |
| 17 | `src/gateway/node-command-policy.ts` | 181 | Node 设备命令过滤 |
| 18 | `src/infra/net/fetch-guard.ts` | 175 | SSRF 防护 |
| 19 | `src/auto-reply/reply/reply-elevated.ts` | 234 | 提权权限判断 |
| 20 | `src/config/types.sandbox.ts` | 76 | 沙箱配置 Schema |
| 21 | `src/agents/session-tool-result-guard.ts` | 249 | 工具结果大小限制 |
| 22 | `src/agents/context-window-guard.ts` | 75 | 上下文窗口保护 |
| | **合计** | **~8000** | **147 个导出项** |

---

## 十五、设计理念

OpenClaw 的安全设计遵循以下原则：

1. **默认最严**：deny + loopback + 无网络 + 只读 + 全部 cap drop，需要用户**显式放宽**
2. **纵深防御**：即使某一层被绕过，后续层仍然有效
3. **最小权限**：每个组件只获得必要的最小权限
4. **审计可追溯**：所有安全相关事件均可审计记录
5. **用户掌控**：关键操作需要用户显式审批，不静默执行
