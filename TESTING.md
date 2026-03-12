# Windows Gateway Restart 修复测试指南

## 修复内容

本 PR 修复了 Windows Gateway 重启时的两个相关问题：

### 问题 1: 端口占用 (EADDRINUSE)
在 `src/daemon/schtasks.ts` 中添加了 `waitForPortFree()` 函数，在重启 Gateway 时等待 TCP 端口释放，防止 EADDRINUSE 错误。

同时添加了 `readScheduledTaskPort()` 函数，从已安装的 task 脚本中读取实际端口（支持自定义端口配置）。

### 问题 2: 健康检查误报超时
在 `src/cli/daemon-cli/restart-health.ts` 中优化了健康检查逻辑：
- 添加 3 秒初始延迟，让新进程有时间启动
- 容忍 stale 进程短暂存在（最多 5 秒）
- 当 runtime 未启动时立即返回，允许清理逻辑运行

## 修改的文件

- `src/daemon/schtasks.ts`
  - 新增 `waitForPortFree()` 辅助函数
  - 新增 `readScheduledTaskPort()` 辅助函数
  - 修改 `restartScheduledTask()` 添加端口释放等待逻辑

- `src/cli/daemon-cli/restart-health.ts`
  - 修改 `waitForGatewayHealthyRestart()` 添加初始延迟和 stale 进程容忍
  - 修改 `waitForGatewayHealthyListener()` 添加初始延迟

## 本地测试步骤

### 方法 1: 构建并安装测试版本

```powershell
# 1. 克隆修复分支
cd %TEMP%
git clone https://github.com/jsfgit/openclaw.git openclaw-fix
cd openclaw-fix

# 2. 安装依赖
pnpm install

# 3. 构建
pnpm build

# 4. 全局安装测试版本
pnpm install -g .

# 5. 测试重启
openclaw gateway restart
```

### 方法 2: 验证修复效果

**预期结果（修复前）**:
```
Restarted Scheduled Task: OpenClaw Gateway
Timed out after 60s waiting for gateway port 18789 to become healthy.
Port 18789 is already in use.
❌ Gateway restart timed out after 60s waiting for health checks.
```

**预期结果（修复后）**:
```
Restarted Scheduled Task: OpenClaw Gateway
✅ Gateway restarted successfully.
```

## 测试用例

### 用例 1: 正常重启
1. 启动 Gateway: `openclaw gateway start`
2. 确认运行：`openclaw gateway status`
3. 执行重启：`openclaw gateway restart`
4. 预期：重启成功，无错误信息

### 用例 2: 快速连续重启
1. 启动 Gateway
2. 连续执行 3 次 `openclaw gateway restart`
3. 预期：每次都能成功重启，无超时错误

### 用例 3: 自定义端口（如果配置了）
1. 配置自定义端口（如 19999）
2. 安装 Gateway: `openclaw gateway install`
3. 执行重启：`openclaw gateway restart`
4. 预期：正确读取自定义端口并等待释放

## 提交 PR 检查清单

- [x] 代码更改完成
- [x] 所有 CR 评论已解决（6 条）
- [ ] 本地测试通过（Windows 构建有问题）
- [x] 文档已更新

## 相关 Issue

- #24706 — Original issue: gateway restart doesn't terminate child processes on Windows
- #24734 — Previous fix (incomplete): recover Windows restarts from unknown stale listeners

## 技术说明

### Windows TIME_WAIT 状态
在 Windows 上，杀掉进程后，TCP 端口可能保持在 TIME_WAIT 状态 30-120 秒。这是正常的 TCP 协议行为，但会导致新进程无法绑定同一端口。

### 修复策略
1. **等待端口释放**: 轮询端口状态，最多等待 30 秒
2. **容忍重叠期**: 允许新旧进程短暂共存（最多 5 秒）
3. **快速失败**: 如果新进程未启动，立即返回允许清理
