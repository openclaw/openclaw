# PR: 飞书通道诊断增强 (Feishu Channel Diagnostic)

## What

新增 `openclaw doctor` 对飞书通道的专项诊断功能，重点关注：

1. **群组策略配置验证** - 检测 `groupPolicy` 和 `groupAllowFrom` 配置完整性
2. **常见配置错误检测** - 识别导致群组消息无法接收的配置问题
3. **账户凭证检查** - 验证 AppID/AppSecret 配置
4. **连接模式诊断** - WebSocket vs Webhook 配置检查

## Why

基于真实用户问题（MEMORY.md 飞书群组消息接收问题排查与修复经验）：

- 用户配置 `groupPolicy: "allowlist"` 但忘记设置 `groupAllowFrom`
- 导致所有群组消息被静默丢弃
- 错误信息不明确，排查困难

**影响：**

- 帮助用户在升级或配置变更后立即发现问题
- 减少 "为什么收不到群组消息" 类问题
- 提升飞书通道配置体验

## How

### 新增文件

1. **`src/commands/doctor-channels-feishu.ts`** - 核心诊断逻辑
   - `diagnoseFeishuChannel()` - 执行诊断
   - `noteFeishuChannelDiagnostic()` - 显示结果

2. **`src/commands/doctor-channels-feishu.test.ts`** - 单元测试
   - 9 个测试用例覆盖各种配置场景

### 修改文件

1. **`src/commands/doctor.ts`** - 集成诊断
   - 导入诊断函数
   - 在安全检查后调用

### 诊断输出示例

```
Feishu Channel
├─ Enabled: ✓
├─ Accounts: 2
├─ Groups: 5
├─
├─ ❌ Issues:
│  └─ Group policy is "allowlist" but groupAllowFrom is not configured
│     This will block ALL group messages!
│     Fix: Add group IDs to channels.feishu.groupAllowFrom
├─
├─ ⚠️  Warnings:
│  └─ 2 configured group(s) not in groupAllowFrom:
│     oc_group1, oc_group2
│     These groups will NOT receive bot messages!
└─
✓ Tips:
   ✓ Group allowlist configured with 3 group(s)
   ✓ Using WebSocket mode for Feishu connection
```

## Testing

### 单元测试

```bash
cd ~/openclaw
pnpm test src/commands/doctor-channels-feishu.test.ts
```

测试覆盖：

- ✅ Feishu 未配置
- ✅ Feishu 被禁用
- ✅ 账户缺失
- ✅ AppID/AppSecret 缺失
- ✅ allowlist 模式缺少 groupAllowFrom
- ✅ open 模式警告
- ✅ 群组不在 allowFrom 列表中
- ✅ 完整配置验证
- ✅ webhook 模式检测

### 手动测试

```bash
# 运行 doctor 查看 Feishu 诊断
openclaw doctor

# 或单独查看（未来扩展）
openclaw doctor channels feishu
```

## Related Issues

- 基于用户真实问题：飞书群组消息接收问题排查（MEMORY.md）
- 相关 Breaking Change：v2026.3.7 `gateway.auth.mode` 配置要求

## Future Enhancements

1. **独立命令** - `openclaw doctor channels feishu` 单独运行
2. **自动修复** - `openclaw doctor --fix` 自动修复配置
3. **其他通道** - 为 Discord/Telegram/Slack 添加类似诊断
4. **详细模式** - `--verbose` 显示更多调试信息

## Checklist

- [x] 代码实现
- [x] 单元测试
- [x] 语法检查通过
- [ ] CI 验证
- [ ] 文档更新（docs/channels/feishu.md）
- [ ] CHANGELOG 更新

---

**AI-Assisted:** ✅ Yes (Codex/Claude)
**Tested:** ✅ Unit tests written, manual testing pending
**Breaking:** ❌ No
**Docs Needed:** ✅ Yes (Feishu configuration guide)
