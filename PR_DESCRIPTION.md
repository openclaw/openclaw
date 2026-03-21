# PR 描述模板

## 标题
```
fix(gateway): block mode=none auth with tailscale serve remote exposure
```

## 描述

### 🔒 安全问题
当 `gateway.auth.mode="none"` 且启用 `tailscale serve` 时，Gateway HTTP API 可在无认证情况下被远程访问，这是一个严重的安全风险。攻击者可能调用敏感工具接口（`/tools/invoke`、`/v1/chat/completions`、`/v1/responses`）执行未授权操作。

### ✅ 修复内容

**1. 新增启动时验证** (`src/gateway/server-runtime-config.ts`)
- 添加检查阻止 `mode=none` + `tailscale serve` 的危险组合
- 错误信息清晰说明需要启用认证

**2. 增强函数文档** (`src/gateway/auth.ts`)
- 为 `assertGatewayAuthConfigured` 添加清晰的文档说明
- 解释为什么 `mode=none` 验证在别处进行（需要 bind/tailscale 上下文）

**3. 更新审计检查** (`src/security/audit-extra.sync.ts`)
- 增强 `collectGatewayHttpNoAuthFindings` 的警告信息
- 说明 `mode=none` + `tailscale serve` 现在会被启动检查阻止
- 提供更清晰的修复建议

**4. 添加测试用例** (`src/gateway/server-runtime-config.test.ts`)
- ✅ `mode=none` + `loopback` → 允许（本地开发）
- ❌ `mode=none` + `tailscale serve` → 拒绝
- ❌ `mode=none` + `tailscale funnel` → 拒绝（已有检查）
- ✅ `mode=token` + `tailscale serve` → 允许

### 🎯 安全改进
- 防止攻击者通过 Tailscale 远程访问无认证的 Gateway API
- 强制要求远程暴露的 gateway 必须启用认证（token/password）
- 保持本地 `loopback + mode=none` 用于开发/测试场景
- 符合 OpenClaw 的安全模型：远程暴露需要认证

### 📝 测试
```bash
# 运行相关测试
npm test -- src/gateway/server-runtime-config.test.ts
```

新增测试用例验证：
- mode=none 与 loopback 绑定（本地开发场景）
- mode=none 与 tailscale serve/funnel（应被阻止）
- mode=token/password 与 tailscale serve（允许）

### 📊 影响范围
- **Breaking Change**: 是（针对使用 `mode=none` + `tailscale serve` 的配置）
- **迁移指南**: 启用 tailscale serve 时必须设置 `gateway.auth.mode=token/password`
- **向后兼容**: 保持 loopback + mode=none 用于本地开发

### 🔗 相关链接
- 修复安全审计发现：`gateway.http.no_auth` (critical when remotely exposed)
- 相关文档：`src/security/dangerous-config-flags.ts`

---

**Checklist:**
- [x] 代码通过现有测试
- [x] 添加新测试用例
- [x] 更新文档/注释
- [x] 安全影响已评估
- [ ] 更新 CHANGELOG（由维护者完成）
