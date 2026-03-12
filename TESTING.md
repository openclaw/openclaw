# Windows Gateway Restart 修复测试指南

## 修复内容

在 `src/daemon/schtasks.ts` 中添加了 `waitForPortFree()` 函数，在重启 Gateway 时等待 TCP 端口释放，防止 EADDRINUSE 错误。

## 修改的文件

- `src/daemon/schtasks.ts`
  - 新增 `waitForPortFree()` 辅助函数
  - 修改 `restartScheduledTask()` 添加端口释放等待逻辑

## 本地测试步骤

### 方法 1: 构建并安装测试版本（推荐）

```powershell
# 1. 克隆修复分支
cd %TEMP%
git clone https://github.com/<your-username>/openclaw.git openclaw-fix
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

### 方法 2: 使用临时脚本（等待 PR 合并期间）

```powershell
# 下载并运行增强版重启脚本（添加端口释放等待）
# 脚本地址：https://github.com/jsfgit/openclaw/blob/fix/windows-restart-port-wait/scripts/gateway-restart-fixed.ps1
powershell -File gateway-restart-fixed.ps1
```

## 预期结果

### 修复前
```
Restarted Scheduled Task: OpenClaw Gateway
Timed out after 60s waiting for gateway port 18789 to become healthy.
Port 18789 is already in use.
Gateway restart timed out after 60s waiting for health checks.
```

### 修复后
```
Restarted Scheduled Task: OpenClaw Gateway
Warning: Port 18789 still in use after 30000ms waiting for release.
Restarted Scheduled Task: OpenClaw Gateway
Gateway restarted successfully.
```

或（理想情况）：
```
Restarted Scheduled Task: OpenClaw Gateway
Restarted Scheduled Task: OpenClaw Gateway
Gateway restarted successfully.
```

## 测试用例

### 用例 1: 正常重启
1. 启动 Gateway: `openclaw gateway start`
2. 确认运行：`openclaw gateway status`
3. 执行重启：`openclaw gateway restart`
4. 预期：重启成功，无错误

### 用例 2: 快速连续重启
1. 启动 Gateway
2. 连续执行 3 次 `openclaw gateway restart`
3. 预期：每次都能成功重启

### 用例 3: 端口占用场景
1. 启动 Gateway
2. 手动创建一个占用 18789 端口的进程（模拟）
3. 执行重启
4. 预期：等待端口释放后成功重启，或显示明确的警告信息

## 提交 PR 检查清单

- [ ] 代码修改完成
- [ ] 本地测试通过
- [ ] 添加测试用例（可选）
- [ ] 更新 CHANGELOG（可选）
- [ ] 提交 PR，关联 Issue #24706

## 相关 Issue

- #24706 — Original issue: gateway restart doesn't terminate child processes on Windows
- #24734 — Previous fix (incomplete): recover Windows restarts from unknown stale listeners
