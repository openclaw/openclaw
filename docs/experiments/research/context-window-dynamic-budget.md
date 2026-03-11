# Context Window Guard 改进提案

## 一、当前问题分析

### 1.1 硬编码阈值现状

通过分析 `/usr/lib/node_modules/openclaw/dist/context-window-guard-CcCAOQZz.js`，发现以下硬编码问题：

```javascript
// 常量定义（硬编码）
const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16e3;      // 16000 tokens
const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32e3;    // 32000 tokens

// 函数中的默认值
const warnBelow = Math.max(1, Math.floor(params.warnBelowTokens ?? 32e3));
const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? 16e3));
```

### 1.2 问题所在

| 问题 | 描述 |
|------|------|
| **固定阈值** | 16K/32K 是固定值，无法适应不同模型的 context window |
| **无百分比支持** | 无法按模型 context window 的比例设置阈值 |
| **小模型浪费** | 32K warning 对 8K context 的模型完全没有意义 |
| **大模型不敏感** | 128K+ 的模型需要更高的阈值才有预警效果 |

---

## 二、改进方案：百分比配置

### 2.1 配置设计

支持两种配置方式：

```typescript
// 方式一：绝对值（保持向后兼容）
contextWindowGuard: {
  warnBelowTokens: 32000,
  hardMinTokens: 16000
}

// 方式二：百分比（新增）
contextWindowGuard: {
  warnBelowPercentage: 0.25,  // 保留 25% 的 context window 作为警告线
  hardMinPercentage: 0.10     // 保留 10% 的 context window 作为硬性最低
}
```

### 2.2 优先级规则

```
百分比配置 > 绝对值配置 > 默认值
```

---

## 三、代码改动思路

### 3.1 改动点 1：扩展类型定义

```typescript
// src/agents/context-window-guard.ts

interface ContextWindowGuardConfig {
  // 绝对值（原有）
  warnBelowTokens?: number;
  hardMinTokens?: number;
  
  // 百分比（新增）
  warnBelowPercentage?: number;  // 0-1 之间
  hardMinPercentage?: number;    // 0-1 之间
}
```

### 3.2 改动点 2：修改 resolveContextWindowInfo

在解析 context window 时，同时获取模型的 total context window：

```typescript
function resolveContextWindowInfo(params) {
  // ... 现有逻辑 ...
  
  // 新增：获取模型总 context window
  const modelTotalContextWindow = fromModelsConfig || fromModel || params.defaultTokens;
  
  return {
    ...baseInfo,
    totalContextWindow: modelTotalContextWindow
  };
}
```

### 3.3 改动点 3：修改 evaluateContextWindowGuard

```typescript
function evaluateContextWindowGuard(params) {
  const { info, cfg } = params;
  const totalTokens = info.totalContextWindow;
  
  // 计算阈值
  let warnBelow: number;
  let hardMin: number;
  
  if (cfg.warnBelowPercentage !== undefined) {
    // 使用百分比
    warnBelow = Math.floor(totalTokens * cfg.warnBelowPercentage);
  } else {
    // 使用绝对值或默认值
    warnBelow = Math.max(1, Math.floor(cfg.warnBelowTokens ?? 32e3));
  }
  
  if (cfg.hardMinPercentage !== undefined) {
    hardMin = Math.floor(totalTokens * cfg.hardMinPercentage);
  } else {
    hardMin = Math.max(1, Math.floor(cfg.hardMinTokens ?? 16e3));
  }
  
  const tokens = Math.max(0, Math.floor(info.tokens));
  
  return {
    ...info,
    tokens,
    warnBelow,
    hardMin,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: tokens > 0 && tokens < hardMin
  };
}
```

### 3.4 配置示例

```json
{
  "agents": {
    "defaults": {
      "contextWindowGuard": {
        "warnBelowPercentage": 0.25,
        "hardMinPercentage": 0.10
      }
    },
    "my-agent": {
      "contextWindowGuard": {
        "warnBelowTokens": 16000,
        "hardMinTokens": 4000
      }
    }
  }
}
```

---

## 四、兼容性

- 默认值保持不变：`warnBelow = 32e3`, `hardMin = 16e3`
- 仅当用户配置了 `*Percentage` 字段时才触发新逻辑
- 现有配置完全兼容

---

## 五、预期收益

| 场景 | 改进前 | 改进后 |
|------|--------|--------|
| 8K context 模型 | 32K warning 无意义 | 自动按 25%/10% 计算 |
| 128K context 模型 | 预警太早 | 按比例预警，更精准 |
| 动态模型切换 | 需手动调整阈值 | 自动适配 |
