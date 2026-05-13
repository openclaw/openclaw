---
name: dingtalk-troubleshoot
description: |
  钉钉连接器问题排查。包含 dws CLI 常见错误处理、授权问题排查和连接故障诊断。
  当 dws 命令执行失败、授权异常、连接中断时自动激活。
---

# 钉钉连接器问题排查

## ❓ 常见问题（FAQ）

### dws 命令返回 "command not found"

**现象**：执行 dws 命令时提示 `command not found: dws`

**原因**：dws CLI 未安装或未加入 PATH。

**解决步骤**：
1. 安装 dws CLI：`npm i -g dingtalk-workspace-cli`
2. 或使用一键安装脚本：`curl -fsSL https://github.com/open-dingtalk/dingtalk-workspace-cli/releases/latest/download/install.sh | sh`
3. 验证安装：`dws --version`（应 >= 1.0.6）

### dws 命令返回 "请先执行 dws login"

**现象**：执行业务命令时提示需要先登录。

**原因**：dws CLI 尚未完成 OAuth 授权。

**解决步骤**：
1. 执行 `dws auth login`
2. 终端会显示二维码，用钉钉扫码完成授权
3. 授权成功后重试原命令

### dws 命令返回 "token expired"

**现象**：命令执行失败，提示 token 已过期。

**原因**：OAuth access_token 已过期。

**解决步骤**：
1. 重新执行 `dws auth login` 刷新授权
2. 授权成功后重试原命令

### dws 命令返回 "permission denied" 或 HTTP 403

**现象**：命令执行失败，提示权限不足。

**原因**：当前用户或应用缺少对应 API 的权限。

**解决步骤**：
1. 确认操作所需的权限范围
2. 联系组织管理员开通对应权限
3. 权限开通后重试原命令

### 连接器扫码后机器人未上线

**现象**：完成 device-auth 扫码后，钉钉中机器人未显示在线。

**可能原因**：
- clientId/clientSecret 配置错误
- 钉钉应用未启用机器人能力
- 网络连接问题

**排查步骤**：
1. 检查 openclaw 日志中是否有连接错误
2. 确认钉钉开放平台中应用已启用「机器人」能力
3. 确认 clientId 和 clientSecret 与开放平台一致
4. 尝试重启 openclaw

## 🔧 错误处理流程

### Recovery 闭环

当 dws 命令的 stderr 中出现 `RECOVERY_EVENT_ID=<event_id>` 时，说明 CLI 检测到可恢复的错误。

**处理流程**：
1. 提取 `RECOVERY_EVENT_ID` 的值
2. 执行 `dws recovery execute --event-id <event_id> --format json` 获取恢复计划
3. 按恢复计划逐步执行
4. 执行 `dws recovery finalize --event-id <event_id>` 完成闭环

详细规范见 dws-cli skill 的 [recovery-guide.md](../dws-cli/references/recovery-guide.md)。

### 通用错误重试

1. 首次失败：加 `--verbose` 重试，获取详细错误信息
2. 检查 stderr 是否匹配已知错误模式（未安装/未登录/过期/权限不足/Recovery）
3. 匹配到已知模式：按对应 FAQ 处理
4. 未匹配：将完整错误信息报告给用户，禁止自行猜测替代方案

### 错误码速查

各产品高频错误码及排查流程见 dws-cli skill 的 [error-codes.md](../dws-cli/references/error-codes.md)。
