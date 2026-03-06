# 修复方案 #34561 - macOS 平台允许列表问题

## 问题根因分析

### 代码定位

文件: `src/gateway/node-command-policy.ts`

1. **第24行**: `SCREEN_DANGEROUS_COMMANDS = ["screen.record"]`
2. **第100-111行**: `PLATFORM_DEFAULTS.macos` 配置未包含 `screen.record`
3. **第65-72行**: `DEFAULT_DANGEROUS_NODE_COMMANDS` 包含危险命令列表

### 问题分析

**对于 `screen.record`:**

- 被归类为 "危险命令" (`SCREEN_DANGEROUS_COMMANDS`)
- 但 macOS 平台的默认允许列表 (`PLATFORM_DEFAULTS.macos`) 未包含屏幕录制命令
- 用户需要手动在配置中添加 `gateway.nodes.allowCommands: ["screen.record"]` 才能使用
- 这不是理想的用户体验，因为 macOS 上的屏幕录制是常见功能

**对于 `system.run.prepare`:**

- 已包含在 `SYSTEM_COMMANDS` (第51-55行)
- 已包含在 `PLATFORM_DEFAULTS.macos` (第110行)
- 理论上应该可以正常工作

### 版本号问题排查

错误消息显示平台为 `"macOS 26.3.0"`，归一化后为 `"macos 26.3.0"`。

检查 `resolvePlatformIdByPrefix` 函数：

- 前缀规则: `{ id: "macos", prefixes: ["mac", "darwin"] }`
- `"macos 26.3.0".startsWith("mac")` → `true`

平台识别应该正确。如果 `system.run.prepare` 也被阻止，可能是版本号字符串包含特殊字符导致匹配失败。

## 修复方案

### 方案A: 添加 screen.record 到 macOS 默认允许列表 (推荐)

在 `PLATFORM_DEFAULTS.macos` 中添加 `screen.record`：

```typescript
macos: [
  ...CANVAS_COMMANDS,
  ...CAMERA_COMMANDS,
  ...LOCATION_COMMANDS,
  ...DEVICE_COMMANDS,
  ...CONTACTS_COMMANDS,
  ...CALENDAR_COMMANDS,
  ...REMINDERS_COMMANDS,
  ...PHOTOS_COMMANDS,
  ...MOTION_COMMANDS,
  ...SYSTEM_COMMANDS,
  "screen.record", // 添加屏幕录制支持
],
```

**优点:**

- 简单直接
- 符合 macOS 用户预期（屏幕录制是系统级功能）
- 不影响其他平台

**风险:**

- 低 - 屏幕录制在 macOS 上本来就是受系统权限控制的

### 方案B: 修复平台识别逻辑 (如果 system.run.prepare 确实被阻止)

如果 `system.run.prepare` 也被阻止，说明平台识别有问题。检查归一化逻辑：

```typescript
function normalizePlatformId(platform?: string, deviceFamily?: string): PlatformId {
  const raw = normalizeDeviceMetadataForPolicy(platform);
  // raw = "macos 26.3.0" (来自 "macOS 26.3.0")
  const byPlatform = resolvePlatformIdByPrefix(raw);
  // 应该匹配 "mac" 前缀
  ...
}
```

可能的问题：版本号中的点号或空格导致匹配失败。

修复：确保前缀匹配只检查字符串开头：

```typescript
function resolvePlatformIdByPrefix(value: string): Exclude<PlatformId, "unknown"> | undefined {
  for (const rule of PLATFORM_PREFIX_RULES) {
    if (rule.prefixes.some((prefix) => value.startsWith(prefix))) {
      return rule.id;
    }
  }
  return undefined;
}
```

当前实现已经正确。如果还有问题，可能需要添加更具体的日志来诊断。

## 推荐方案

**采用方案A**: 将 `screen.record` 添加到 `PLATFORM_DEFAULTS.macos` 中。

理由：

1. 符合 macOS 平台功能预期
2. 改动最小，风险最低
3. `system.run.prepare` 应该已经正常工作，如果用户报告它也被阻止，可能是配置或其他问题

## 测试计划

1. 验证 TypeScript 编译通过
2. 验证单元测试通过
3. 手动验证：在 macOS 上执行 `screen.record` 命令

## 文件变更

- `src/gateway/node-command-policy.ts`: 添加 `"screen.record"` 到 `PLATFORM_DEFAULTS.macos`
