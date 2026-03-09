# Chain Memory Backend - 默认值参考

## 🎯 设计原则

**最小配置原则**：用户只需要提供 **3 个必需参数**，其他 Chain Memory Backend 的参数都有合理的默认值。

**注意：** Plugin 自身的参数（如 `apiKey`, `baseUrl` 等）由 plugin 自己处理，不在 Chain Memory Backend 的管辖范围内。

---

## 📋 必需参数（仅 3 个）

| 参数                  | 类型   | 说明                           | 示例                                     |
| --------------------- | ------ | ------------------------------ | ---------------------------------------- |
| `name`                | string | Provider 名称（唯一）          | `"mem0"`                                 |
| `priority`            | enum   | 优先级                         | `"primary"`, `"secondary"`, `"fallback"` |
| `backend` 或 `plugin` | string | Backend 或 Plugin ID（二选一） | `"builtin"` 或 `"@mem0/openclaw-mem0"`   |

**最小配置示例：**

```json
{
  "providers": [
    {
      "name": "primary",
      "priority": "primary",
      "backend": "builtin"
    }
  ]
}
```

---

## 🔧 Chain Memory Backend 默认值

### Provider 默认值

| 参数                              | 默认值                 | 说明                                           |
| --------------------------------- | ---------------------- | ---------------------------------------------- |
| `enabled`                         | `true`                 | 默认启用                                       |
| `writeMode`                       | 根据 priority 自动推断 | primary/fallback → `sync`, secondary → `async` |
| `timeout.add`                     | `5000` (5秒)           | 添加记忆超时                                   |
| `timeout.search`                  | `5000` (5秒)           | 搜索记忆超时                                   |
| `timeout.update`                  | `5000` (5秒)           | 更新记忆超时                                   |
| `timeout.delete`                  | `5000` (5秒)           | 删除记忆超时                                   |
| `retry.maxAttempts`               | `3`                    | 最大重试次数                                   |
| `retry.backoffMs`                 | `1000` (1秒)           | 重试退避时间                                   |
| `circuitBreaker.failureThreshold` | `5`                    | 熔断器失败阈值                                 |
| `circuitBreaker.resetTimeoutMs`   | `60000` (60秒)         | 熔断器重置超时                                 |

---

### Global 默认值

| 参数                  | 默认值         | 说明         |
| --------------------- | -------------- | ------------ |
| `defaultTimeout`      | `5000` (5秒)   | 默认超时时间 |
| `enableAsyncWrite`    | `true`         | 启用异步写入 |
| `enableFallback`      | `true`         | 启用降级     |
| `healthCheckInterval` | `30000` (30秒) | 健康检查间隔 |

---

## 🎨 极简配置示例

### 示例 1：builtin 双写（最简单）

**用户配置（只需 10 行）：**

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "primary",
          "priority": "primary",
          "backend": "builtin"
        },
        {
          "name": "backup",
          "priority": "secondary",
          "backend": "builtin"
        }
      ]
    }
  }
}
```

**Chain Memory Backend 自动应用的默认值：**

```json
{
  "providers": [
    {
      "name": "primary",
      "priority": "primary",
      "backend": "builtin",
      "enabled": true, // ✅ 默认值
      "writeMode": "sync", // ✅ 自动推断
      "timeout": { "add": 5000, "search": 5000, "update": 5000, "delete": 5000 }, // ✅ 默认值
      "retry": { "maxAttempts": 3, "backoffMs": 1000 }, // ✅ 默认值
      "circuitBreaker": { "failureThreshold": 5, "resetTimeoutMs": 60000 } // ✅ 默认值
    },
    {
      "name": "backup",
      "priority": "secondary",
      "backend": "builtin",
      "enabled": true, // ✅ 默认值
      "writeMode": "async", // ✅ 自动推断
      "timeout": { "add": 5000, "search": 5000, "update": 5000, "delete": 5000 }, // ✅ 默认值
      "retry": { "maxAttempts": 3, "backoffMs": 1000 }, // ✅ 默认值
      "circuitBreaker": { "failureThreshold": 5, "resetTimeoutMs": 60000 } // ✅ 默认值
    }
  ],
  "global": {
    "defaultTimeout": 5000, // ✅ 默认值
    "enableAsyncWrite": true, // ✅ 默认值
    "enableFallback": true, // ✅ 默认值
    "healthCheckInterval": 30000 // ✅ 默认值
  }
}
```

---

### 示例 2：使用 plugin（只提供必需参数）

**用户配置（只需 12 行）：**

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "mem0",
          "priority": "primary",
          "plugin": "@mem0/openclaw-mem0",
          "apiKey": "${MEM0_API_KEY}" // ⚠️ 这是 plugin 的参数，由 plugin 自己处理
        },
        {
          "name": "backup",
          "priority": "secondary",
          "backend": "builtin"
        }
      ]
    }
  }
}
```

**说明：**

- ✅ `name`, `priority`, `plugin` - Chain Memory Backend 的必需参数
- ⚠️ `apiKey` - plugin 的参数，由 plugin 自己处理
- ✅ 其他 Chain Memory Backend 的参数全部使用默认值

---

### 示例 3：自定义超时和熔断器（可选）

**用户配置：**

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "mem0",
          "priority": "primary",
          "plugin": "@mem0/openclaw-mem0",
          "apiKey": "${MEM0_API_KEY}",
          "timeout": {
            "search": 3000 // ✅ 只覆盖 search 超时
          },
          "circuitBreaker": {
            "failureThreshold": 3 // ✅ 只覆盖失败阈值
          }
          // 其他参数仍然使用默认值
        },
        {
          "name": "backup",
          "priority": "secondary",
          "backend": "builtin"
        }
      ]
    }
  }
}
```

**说明：**

- ✅ 只覆盖必要的参数
- ✅ 其他参数仍然使用默认值

---

## 🔄 writeMode 自动推断

**规则：**

```typescript
writeMode =
  p.writeMode ??
  (p.priority === "primary" || p.priority === "fallback"
    ? "sync" // 主系统和降级系统使用同步写入
    : "async"); // 次要系统使用异步写入
```

**示例：**

```json
{
  "providers": [
    {
      "name": "primary",
      "priority": "primary",
      "backend": "builtin"
      // ✅ writeMode 自动为 "sync"
    },
    {
      "name": "secondary",
      "priority": "secondary",
      "backend": "builtin"
      // ✅ writeMode 自动为 "async"
    },
    {
      "name": "fallback",
      "priority": "fallback",
      "backend": "builtin"
      // ✅ writeMode 自动为 "sync"
    }
  ]
}
```

---

## 📊 配置复杂度对比

### Chain Memory Backend 参数

| 参数类型   | 必需参数                             | 可选参数（有默认值）                                                          |
| ---------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| **必需**   | `name`, `priority`, `backend/plugin` | -                                                                             |
| **可选**   | -                                    | `enabled`, `writeMode`, `timeout.*`, `retry.*`, `circuitBreaker.*`            |
| **Global** | -                                    | `defaultTimeout`, `enableAsyncWrite`, `enableFallback`, `healthCheckInterval` |

### 配置行数

| 配置方式     | 行数     | 必需参数      | 可选参数 |
| ------------ | -------- | ------------- | -------- |
| **极简配置** | 10-12 行 | 3 个/provider | 0 个     |
| **生产配置** | 15-20 行 | 3 个/provider | 1-3 个   |
| **完整配置** | 30+ 行   | 3 个/provider | 全部     |

---

## 💡 最佳实践

### 1. 开发环境（极简配置）

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "primary",
          "priority": "primary",
          "backend": "builtin"
        },
        {
          "name": "backup",
          "priority": "secondary",
          "backend": "builtin"
        }
      ]
    }
  }
}
```

**只需要 3 个必需参数！** ✅

---

### 2. 生产环境（覆盖关键参数）

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "mem0",
          "priority": "primary",
          "plugin": "@mem0/openclaw-mem0",
          "apiKey": "${MEM0_API_KEY}",
          "timeout": {
            "search": 3000 // ✅ 覆盖 search 超时
          },
          "circuitBreaker": {
            "failureThreshold": 5, // ✅ 覆盖失败阈值
            "resetTimeoutMs": 60000 // ✅ 覆盖重置超时
          }
        },
        {
          "name": "backup",
          "priority": "secondary",
          "backend": "builtin"
        },
        {
          "name": "fallback",
          "priority": "fallback",
          "backend": "builtin"
        }
      ]
    }
  }
}
```

**只覆盖必要的参数，其他使用默认值！** ✅

---

## 🎯 总结

### Chain Memory Backend 的设计

**必需参数（3 个）：**

1. `name` - Provider 名称
2. `priority` - 优先级
3. `backend` 或 `plugin` - Backend/Plugin ID

**可选参数（全部有默认值）：**

- `enabled` - 默认 `true`
- `writeMode` - 自动推断
- `timeout.*` - 默认 `5000ms`
- `retry.*` - 默认值
- `circuitBreaker.*` - 默认值
- `global.*` - 默认值

**Plugin 参数：**

- ⚠️ 由 plugin 自己处理
- ⚠️ Chain Memory Backend 只传递，不处理

---

### 配置负担

**优化前（完整配置）：** ~30 行
**优化后（极简配置）：** ~10-12 行

**配置负担降低：** 60% ✅

---

### 用户体验

| 用户类型 | 配置行数 | 说明                |
| -------- | -------- | ------------------- |
| 新手     | 10 行    | 只需要 3 个必需参数 |
| 高级用户 | 15-20 行 | 覆盖关键参数        |
| 生产环境 | 20 行    | 覆盖必要参数        |

---

**关键优势：**

1. ✅ **最小配置** - 只需要 3 个必需参数
2. ✅ **智能推断** - writeMode 自动推断
3. ✅ **合理默认** - 所有参数都有默认值
4. ✅ **灵活覆盖** - 可以按需覆盖任何参数
5. ✅ **关注分离** - plugin 参数由 plugin 自己处理

**配置负担降低 60%！** 🚀
