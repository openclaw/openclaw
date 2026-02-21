# 火山引擎 ECS 上 OpenClaw 部署与安全分析

> 分析日期：2026-02-21
> 目标机器：118.145.117.110（火山引擎 ECS）

---

## 一、服务器环境

| 项目 | 值 |
|---|---|
| OS | Ubuntu 24.04 LTS (x86_64) |
| 内核 | 6.8.0-55-generic |
| 虚拟化 | KVM (OpenStack Nova) |
| 实例名 | iv-yeg89z9fy8obzsyd99t0 |
| CPU | 2 核 (AVX-512) |
| 内存 | 2G |
| 磁盘 | 40G (`/dev/vda`, ext4) |
| Node.js | v22.22.0 |
| npm | 10.9.4 |

**是 ECS 云主机（KVM 虚拟机），不是 Docker 容器。** 判断依据：
- `systemd-detect-virt` → `kvm`
- `/sys/class/dmi/id/product_name` → `OpenStack Nova`
- PID 1 为 systemd，有完整内核引导
- 无 `/.dockerenv`
- 主机名 `iv-` 前缀为火山引擎 ECS 命名规范

---

## 二、OpenClaw 部署方式

### 2.1 安装

- **方式**：npm 全局安装
- **路径**：`/usr/lib/node_modules/openclaw/`
- **二进制**：`/usr/bin/openclaw`
- **版本**：2026.2.13

### 2.2 运行

- **服务管理**：systemd 用户级服务（`systemctl --user`）
- **服务文件**：`/root/.config/systemd/user/openclaw-gateway.service`
- **启动命令**：

```bash
/usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js gateway --port 18789
```

- **运行用户**：root
- **重启策略**：`Restart=always`，间隔 5 秒
- **内存限制**：MemoryMax=1573M，MemoryHigh=1475M

### 2.3 网络

| 端口 | 绑定 | 用途 |
|---|---|---|
| 18789 | 127.0.0.1 (loopback) | Gateway WebSocket |
| 18792 | 127.0.0.1 (loopback) | 内部服务 |

**不对公网暴露**，仅绑定 loopback。

### 2.4 配置

- **配置目录**：`/root/.openclaw/`
- **Gateway 模式**：local
- **默认模型**：`ark/deepseek-v3.2`（火山引擎 ARK 平台）
- **工作空间**：`/root/.openclaw/workspace`
- **认证**：Token 模式

### 2.5 已安装插件

| 插件 | 来源 | 版本 | 状态 |
|---|---|---|---|
| dingtalk-connector | GitHub | 0.6.0 | 已启用 |
| wecom (企业微信) | npm `@openclaw-china/wecom` | 0.1.20 | 已启用，未配置 |
| qqbot | 本地 `/root/qqbot` | 1.2.3 | 已启用 |
| ai-assistant-security-openclaw | npm `@omni-shield/...` | 1.0.0-beta22 | 注册失败 |

---

## 三、安全机制分析

### 3.1 OpenClaw 自身的安全体系（九层纵深防御）

#### 第一层：默认安全策略 — deny

```typescript
// src/infra/exec-approvals.ts
export const DEFAULT_SECURITY = "deny";
```

三档安全级别：
- **deny**（默认）：完全禁止执行任何命令
- **allowlist**：仅允许白名单中的命令
- **full**：允许所有（需显式开启）

该服务器 `tools`/`sandbox`/`exec` 配置均为空，走默认 deny 模式。

#### 第二层：Allowlist 白名单

```typescript
export const DEFAULT_SAFE_BINS = ["jq", "grep", "cut", "sort", "uniq", "head", "tail", "tr", "wc"];
```

即使升级到 allowlist 模式，`rm` 等危险命令不在白名单中。白名单内的命令也会进一步检查参数（路径 token、已有文件等）。

#### 第三层：Shell 命令深度解析

- 解析管道 `|`、链式 `&&`/`||`/`;`
- 每个段单独做 allowlist 检查
- 拒绝危险 shell token：`>`、`<`、`` ` ``、`$()`、`\n`
- 防止 `echo innocent && rm -rf /` 类链式绕过

#### 第四层：用户审批流程

```typescript
export type ExecAsk = "off" | "on-miss" | "always";
```

- `on-miss`：不在白名单的命令需要用户手动批准
- `always`：所有命令都需要用户确认

#### 第五层：Docker 容器沙箱隔离

（该服务器未安装 Docker，此层未启用）

| 加固措施 | 效果 |
|---|---|
| `--cap-drop ALL` | 丢弃所有 Linux capabilities |
| `--read-only` | 只读根文件系统 |
| `--network none` | 无网络访问 |
| `--security-opt no-new-privileges` | 禁止提权 |
| 非 root 用户 `sandbox` | 最小权限 |
| 内存/CPU/PID 限制 | 资源隔离 |

#### 第六层：宿主环境变量保护

```typescript
const DANGEROUS_HOST_ENV_VARS = new Set([
  "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS",
  "PYTHONPATH", "BASH_ENV", "IFS", ...
]);
```

阻止 LD_PRELOAD 注入、PATH 劫持等。

#### 第七层：路径沙箱限制

```typescript
// src/agents/sandbox-paths.ts
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error(`Path escapes sandbox root: ${filePath}`);
}
```

- 所有路径必须在沙箱根目录内
- 符号链接遍历检测
- Unicode 空格规范化

#### 第八层：外部内容注入防护

```typescript
// src/security/external-content.ts
const SUSPICIOUS_PATTERNS = [
  /rm\s+-rf/i,
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  /elevated\s*=\s*true/i,
  /delete\s+all\s+(emails?|files?|data)/i,
];
```

对外部消息/邮件/webhook 内容进行可疑模式检测。

#### 第九层：技能代码安全扫描

```typescript
// src/security/skill-scanner.ts
```

扫描插件/技能代码中的：child_process 调用、动态代码执行（eval）、加密货币挖矿、数据渗出、环境变量窃取、混淆代码等。

---

### 3.2 火山云新增的安全能力

仅有 `@omni-shield/ai-assistant-security-openclaw` 插件，通过 OpenClaw hook 机制接入：

- **隐私脱敏**：发给模型前拦截身份证/手机号等敏感信息
- **高危操作拦截**：在 tool call 前判断转账、删文件等高危操作
- **提示词注入检测**：通过远端 API 检测恶意 prompt

> ⚠️ 该服务器上此插件注册失败：`Verification failed for endpoint ... Error: This operation was aborted`

---

### 3.3 火山云宣传文章 vs 实际归属

> 来源：[让OpenClaw安全上岗，火山引擎发布业界首个AI助手安全方案](https://mp.weixin.qq.com/s/Ifbbzd6Ia_Wwv4iLgnR6yA)

| 火山云宣称的能力 | 实际来源 |
|---|---|
| 默认绑定本地端口 | **OpenClaw 自身** (`gateway.bind: "loopback"`) |
| Token/密码认证 | **OpenClaw 自身** (`gateway.auth`) |
| 指令过滤/提示词加固 | **OpenClaw 自身** (`external-content.ts`) |
| 沙箱隔离/非 Root | **OpenClaw 自身** (`Dockerfile.sandbox`, `sandbox/docker.ts`) |
| 技能深度扫描 | **OpenClaw 自身** (`skill-scanner.ts`) |
| 定期 Cron 巡检 | **OpenClaw 自身** (cron 机制) |
| 动态加载拦截 | **OpenClaw 自身** (插件加载流程) |
| 隐私脱敏 + 高危操作拦截 + prompt 注入检测 | **火山云插件** (`@omni-shield/ai-assistant-security-openclaw`) |

**结论**：文章将 OpenClaw 开源项目已有的安全机制包装为"火山引擎三层纵深安全方案"。火山云实际新增的仅有 `ai-assistant-security-openclaw` 插件一项。

---

## 四、`rm -rf /` 的防御路径

当 AI agent 尝试执行 `rm -rf /` 时：

```
模型输出 tool_call: exec("rm -rf /")
  │
  ▼
① 默认 security=deny → 直接拒绝 ✘
  │ (如果升级到 allowlist)
  ▼
② rm 不在白名单 → 拒绝 ✘
  │ (如果升级到 full)
  ▼
③ Shell 解析：检测到 rm → 标记为危险
  │
  ▼
④ 审批流程：ask=on-miss/always → 需用户确认
  │
  ▼
⑤ 沙箱模式(如启用)：容器内只读文件系统 + 非 root → 即使执行也无效
  │
  ▼
⑥ 环境变量保护：阻止 PATH 劫持
  │
  ▼
⑦ 路径限制：不能逃出 sandbox root
  │
  ▼
⑧ 外部内容扫描：/rm\s+-rf/i 被检测为可疑
```

---

## 五、该服务器当前风险点

1. **以 root 运行**：openclaw-gateway 以 root 身份运行，如果安全策略被绕过，影响范围大
2. **未启用 Docker 沙箱**：服务器未安装 Docker，沙箱隔离层缺失
3. **安全插件失效**：`ai-assistant-security-openclaw` 注册失败，远端 API 不可达
4. **WeCom 未配置完成**：已启用但 token 为空
5. **多个频道 token 为空**：飞书、Telegram、钉钉等 `.env` 中未配置
6. **有可用更新未安装**：当前 2026.2.13，最新 2026.2.19-2
