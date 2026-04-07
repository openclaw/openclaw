---
name: wecom-preflight
description: 企业微信插件前置条件检查。在执行任何 wecom_mcp 操作前，通过 shell 命令检查工具权限配置（profile 和白名单），若缺失则自动修复并提示用户重启 Gateway。所有使用 wecom_mcp 的技能都应在首次调用前执行此检查。
---

# 企业微信前置条件检查

> 本技能确保 `wecom_mcp` 工具已正确获得执行权限。**所有使用 wecom_mcp 的技能在首次调用前，必须先执行本检查流程。**

## 触发条件

当满足以下**任一条件**时，执行前置检查：

1. 当前会话中**首次**需要调用 `wecom_mcp` 工具
2. 调用 `wecom_mcp` 时收到 `tool not allowed`、`not permitted`、`permission denied` 或类似权限错误

> 如果当前会话中已成功调用过 `wecom_mcp`（任何操作），则无需重复检查。

---

## 检查流程

> **重要**：以下所有步骤均为 **shell 命令**（在终端中执行），**不是** MCP tool 调用。
> `wecom_mcp` 在未加入白名单前对 AI Agent 不可见，因此不能用 tool 调用来探测。

### 步骤 1：检查 tools.profile

在终端执行以下命令，读取当前 `tools.profile` 配置：

```bash
openclaw config get tools.profile
```

根据返回结果分流：

- **返回 `full`** → ✅ **检查通过**。`full` 模式无任何工具限制，所有工具（包括 `wecom_mcp`）直接可用，无需检查 `alsoAllow`，继续执行用户原始请求
- **返回其他值**（如 `coding`、`messaging`、`minimal`、`undefined` 或空）→ 进入步骤 1b（检查 alsoAllow）
- **命令执行失败**（如 `command not found: openclaw`、权限错误等）→ 进入步骤 3（环境异常）

### 步骤 1b：检查 tools.alsoAllow

在终端执行以下命令，读取当前 `tools.alsoAllow` 配置：

```bash
openclaw config get tools.alsoAllow
```

根据返回结果分流：

- **返回内容包含 `wecom_mcp`**（如 `["wecom_mcp"]` 或 `["wecom_mcp", "other_tool"]`）→ ✅ 白名单已配置，检查通过，继续执行用户原始请求
- **返回内容不包含 `wecom_mcp`**（如空数组 `[]`、`undefined`、或列表中没有 `wecom_mcp`）→ 进入步骤 2（自动修复）
- **命令执行失败** → 进入步骤 3（环境异常）

---

### 步骤 2：自动修复 tools.alsoAllow

在终端执行以下命令，将 `wecom_mcp` 加入工具白名单：

```bash
openclaw config set tools.alsoAllow '["wecom_mcp"]'
```

> **注意**：如果步骤 1b 返回的列表中已有其他工具（如 `["other_tool"]`），需要合并后再写入，例如：
> ```bash
> openclaw config set tools.alsoAllow '["other_tool", "wecom_mcp"]'
> ```

根据执行结果分流：

#### 2a. 命令执行成功

向用户回复（**不要自动执行重启**）：

```
✅ 已自动将 wecom_mcp 加入工具执行权限白名单（tools.alsoAllow）。
⚠️ 配置变更需要重启 Gateway 后才能生效，请在终端执行以下命令：

openclaw gateway restart

重启完成后请重新发送您的请求。
```

> **为什么不自动重启**：`openclaw gateway restart` 会中断当前所有活跃连接（包括本会话），
> 如果由 AI 自动执行，用户可能无法看到完整的提示信息。交由用户手动重启更可控。

#### 2b. 命令执行失败

向用户回复以下手动修复指引：

```
❌ 自动配置失败，请在终端手动执行以下命令：

openclaw config set tools.alsoAllow '["wecom_mcp"]'
openclaw gateway restart

完成后请重新发送您的请求。
```

---

### 步骤 3：环境异常处理

如果步骤 1 或 1b 的 `openclaw` 命令本身执行失败（如 `command not found`、权限不足等），说明 OpenClaw CLI 未正确安装或不在 PATH 中，直接告知用户：

```
⚠️ OpenClaw CLI 不可用：<错误信息>

可能原因：
- OpenClaw 未安装或未加入系统 PATH
- OpenClaw 版本过低，不支持 config 子命令
- 当前 shell 环境缺少必要配置

请检查 OpenClaw 安装状态后重试。
参考：https://docs.openclaw.dev/installation
```

---

## 注意事项

1. **全程使用 shell 命令**：本技能的所有探测和修复操作均通过 `openclaw` CLI 在终端中执行，**不涉及任何 MCP tool 调用**。这样可以避免"tool 未白名单 → tool 不可见 → 无法探测"的死锁问题
2. **profile 优先判断**：`tools.profile` 为 `full` 时所有工具无限制，无需检查 `alsoAllow`，可快速跳过
3. **幂等性**：如果 `tools.alsoAllow` 中已包含 `wecom_mcp`，`openclaw config set` 命令不会产生副作用
4. **保留已有配置**：修改 `tools.alsoAllow` 时，需保留列表中已有的其他工具名，仅追加 `wecom_mcp`
5. **不自动重启**：自动配置成功后仅提示用户重启并附上命令，由用户手动执行，避免会话中断导致信息丢失
6. **会话缓存**：在同一个会话中，一旦检查通过（profile 为 full 或 alsoAllow 包含 wecom_mcp），后续调用无需重复检查

---

## 快速参考

| 场景 | 处理方式 |
|------|---------|
| 首次调用 wecom_mcp 前 | 执行 `openclaw config get tools.profile` 检查 |
| `tools.profile` 为 `full` | ✅ 跳过，直接执行原始请求 |
| profile 非 full + alsoAllow 已包含 wecom_mcp | ✅ 跳过，继续执行 |
| profile 非 full + alsoAllow 不包含 → 自动写入成功 | 提示已配置 + 附 `openclaw gateway restart` 命令让用户重启 |
| profile 非 full + alsoAllow 不包含 → 自动写入失败 | 给出手动修复指引 |
| openclaw CLI 不可用 | 告知用户检查 OpenClaw 安装 |
| 会话中已成功调用过 wecom_mcp | 跳过检查 |
