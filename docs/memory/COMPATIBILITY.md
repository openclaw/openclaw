# Chain Memory Backend - 兼容性指南

## 🎯 设计原则

**完全向后兼容，用户无需任何修改即可继续使用现有功能。**

### 核心原则

1. ✅ **默认行为不变** - 不使用 `chain` backend 时，行为完全不变
2. ✅ **渐进式采用** - 用户可以随时选择启用一读多写功能
3. ✅ **零学习成本** - 即使不知道这个功能，也不会出错
4. ✅ **透明升级** - 从旧配置迁移到新配置非常简单

---

## 📋 使用场景

### 场景 1：旧配置（完全向后兼容）

**用户完全不知道 chain backend，使用旧配置：**

```json
{
  "memory": {
    "backend": "builtin"
  }
}
```

**或使用 plugin：**

```json
{
  "plugins": {
    "slots": {
      "memory": "@mem9/openclaw"
    }
  }
}
```

**行为：**

- ✅ 完全不变，和之前一样
- ✅ 不启动 ChainMemoryManager
- ✅ 使用原有的 memory 系统
- ✅ 无任何性能影响

---

### 场景 2：启用一读多写（新功能）

**用户明确启用 chain backend：**

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "mem9",
          "priority": "primary",
          "plugin": "@mem9/openclaw",
          "apiUrl": "http://localhost:8080",
          "tenantID": "uuid"
        },
        {
          "name": "builtin-backup",
          "priority": "secondary",
          "backend": "builtin",
          "writeMode": "async"
        }
      ]
    }
  }
}
```

**行为：**

- ✅ 启动 ChainMemoryManager
- ✅ 主系统：mem9-ai（云端记忆）
- ✅ 备份系统：builtin（本地 SQLite）
- ✅ 自动故障隔离和降级

---

## 🔄 迁移路径

### 从 builtin 迁移到 chain + builtin 备份

**之前：**

```json
{
  "memory": {
    "backend": "builtin"
  }
}
```

**之后（添加备份）：**

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "builtin",
          "priority": "primary",
          "backend": "builtin"
        },
        {
          "name": "backup",
          "priority": "secondary",
          "backend": "builtin",
          "writeMode": "async",
          "store": {
            "path": "~/.openclaw/memory/backup-{agentId}.sqlite"
          }
        }
      ]
    }
  }
}
```

**效果：**

- ✅ 主系统：继续使用 builtin
- ✅ 备份系统：自动异步写入到另一个数据库
- ✅ 主系统故障时自动降级到备份

---

### 从 @mem0/openclaw-mem0 迁移到 chain + builtin 备份

**之前：**

```json
{
  "plugins": {
    "slots": {
      "memory": "@mem0/openclaw-mem0"
    },
    "entries": {
      "openclaw-mem0": {
        "enabled": true,
        "config": {
          "apiKey": "${MEM0_API_KEY}",
          "userId": "default"
        }
      }
    }
  }
}
```

**之后（添加备份）：**

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
          "userId": "default"
        },
        {
          "name": "builtin-backup",
          "priority": "secondary",
          "backend": "builtin",
          "writeMode": "async"
        }
      ]
    }
  }
}
```

**效果：**

- ✅ 主系统：继续使用 Mem0（AI 增强记忆）
- ✅ 备份系统：自动异步写入到本地 builtin
- ✅ 完全兼容 Mem0 的所有功能

---

### 从 @mem9/openclaw 迁移到 chain + builtin 备份

**之前：**

```json
{
  "plugins": {
    "slots": {
      "memory": "openclaw"
    },
    "entries": {
      "openclaw": {
        "enabled": true,
        "config": {
          "apiUrl": "http://localhost:8080",
          "tenantID": "uuid"
        }
      }
    }
  }
}
```

**之后（添加备份）：**

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "mem9",
          "priority": "primary",
          "plugin": "@mem9/openclaw",
          "apiUrl": "http://localhost:8080",
          "tenantID": "uuid"
        },
        {
          "name": "builtin-backup",
          "priority": "secondary",
          "backend": "builtin",
          "writeMode": "async"
        }
      ]
    }
  }
}
```

**效果：**

- ✅ 主系统：继续使用 mem9（云端持久记忆）
- ✅ 备份系统：自动异步写入到本地 builtin
- ✅ 完全兼容 mem9 的所有功能

---

## 🎨 配置示例

### 示例 1：简单双写（builtin + builtin）

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
          "backend": "builtin",
          "writeMode": "async",
          "store": {
            "path": "~/.openclaw/memory/backup-{agentId}.sqlite"
          }
        }
      ]
    }
  }
}
```

---

### 示例 2：云端记忆 + 本地备份

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "mem9",
          "priority": "primary",
          "plugin": "@mem9/openclaw",
          "apiUrl": "http://localhost:8080",
          "tenantID": "uuid"
        },
        {
          "name": "builtin-backup",
          "priority": "secondary",
          "backend": "builtin",
          "writeMode": "async"
        }
      ]
    }
  }
}
```

---

### 示例 3：多级降级（云端 → builtin → fallback）

```json
{
  "memory": {
    "backend": "chain",
    "chain": {
      "providers": [
        {
          "name": "mem9",
          "priority": "primary",
          "plugin": "@mem9/openclaw",
          "apiUrl": "http://localhost:8080",
          "tenantID": "uuid",
          "timeout": {
            "search": 3000
          },
          "circuitBreaker": {
            "failureThreshold": 5,
            "resetTimeoutMs": 60000
          }
        },
        {
          "name": "builtin-backup",
          "priority": "secondary",
          "backend": "builtin",
          "writeMode": "async"
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

---

### 示例 4：混合使用 backend 和 plugin

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
          "userId": "default"
        },
        {
          "name": "qmd-backup",
          "priority": "secondary",
          "backend": "qmd",
          "writeMode": "async"
        },
        {
          "name": "builtin-fallback",
          "priority": "fallback",
          "backend": "builtin"
        }
      ]
    }
  }
}
```

---

## 🔧 技术实现

### 如何判断是否启用 chain？

```typescript
// OpenClaw 核心代码（伪代码）
function getMemoryManager(config: OpenClawConfig): MemorySearchManager {
  // 1. 检查是否明确使用 chain backend
  if (config.memory?.backend === "chain") {
    // 启用 ChainMemoryManager
    return new ChainMemoryManager({
      config: config.memory.chain,
      getBackendManager: (backend, cfg) => {
        return createBackendManager(backend, cfg);
      },
      getPluginManager: (plugin, cfg) => {
        return createPluginManager(plugin, cfg);
      },
    });
  }

  // 2. 使用原有逻辑（完全向后兼容）
  return createDefaultMemoryManager(config);
}
```

### 关键点

1. **只有 `memory.backend === 'chain'` 时才启用新功能**
2. **其他情况完全不变**
3. **无需修改现有代码**
4. **渐进式采用**

---

## ✅ 兼容性矩阵

| 配置方式                                       | 启用 Chain? | 行为   | 兼容性      |
| ---------------------------------------------- | ----------- | ------ | ----------- |
| `memory.backend = "builtin"`                   | ❌          | 旧逻辑 | ✅ 完全兼容 |
| `memory.backend = "qmd"`                       | ❌          | 旧逻辑 | ✅ 完全兼容 |
| `plugins.slots.memory = "@mem9/openclaw"`      | ❌          | 旧逻辑 | ✅ 完全兼容 |
| `plugins.slots.memory = "@mem0/openclaw-mem0"` | ❌          | 旧逻辑 | ✅ 完全兼容 |
| `memory.backend = "chain"`                     | ✅          | 新逻辑 | ✅ 完全兼容 |

---

## 🎯 总结

### 设计优势

1. ✅ **零破坏性** - 旧配置继续工作
2. ✅ **零学习成本** - 不需要了解新功能
3. ✅ **渐进式采用** - 随时可以选择启用
4. ✅ **完全兼容** - 支持所有 plugin 和 backend
5. ✅ **简单迁移** - 从旧到新非常简单

### 用户影响

| 用户类型         | 影响 | 需要做的事   |
| ---------------- | ---- | ------------ |
| 完全不知道新功能 | 无   | 无           |
| 听说过但不想用   | 无   | 无           |
| 想要使用新功能   | 正面 | 修改配置文件 |

---

**结论：完全向后兼容，用户可以按需采用，无需任何强制性改变。** 🚀
