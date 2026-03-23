# Infra 核心模块详解

> Infra 提供基础设施功能，包括备份、归档、发现、网络等底层支持。

## 目录

1. [Infra 概述](#infra-概述)
2. [备份系统](#备份系统)
3. [归档系统](#归档系统)
4. [网络发现](#网络发现)
5. [工具函数](#工具函数)

---

## Infra 概述

### 什么是 Infra？

**Infra = 基础设施层**

它提供：
- 💾 **备份**：数据备份与恢复
- 📦 **归档**：历史数据归档
- 🔍 **发现**：设备和服务发现
- 🌐 **网络**：网络工具和功能

---

## 备份系统

### 备份类型

| 类型 | 说明 | 频率 |
|------|------|------|
| **Auto** | 自动备份 | 定期 |
| **Manual** | 手动备份 | 按需 |
| **Rotation** | 轮转备份 | 保留 N 份 |

### 备份配置

```json5
{
  "infra": {
    "backup": {
      "enabled": true,
      "interval": "daily",      // daily/weekly/monthly
      "retention": 7,           // 保留 7 份
      "path": "~/.openclaw/backups"
    }
  }
}
```

### 备份命令

```bash
# 创建备份
openclaw backup create

# 列出备份
openclaw backup list

# 恢复备份
openclaw backup restore <backup-id>

# 删除备份
openclaw backup delete <backup-id>
```

---

## 归档系统

### 归档策略

```
活跃数据 → 冷数据 → 归档
   ↓         ↓        ↓
  内存     磁盘     压缩文件
```

### 归档配置

```json5
{
  "infra": {
    "archive": {
      "enabled": true,
      "threshold": {
        "age": 30,        // 30 天后归档
        "size": "1GB"     // 或达到 1GB
      },
      "compression": "gzip",
      "path": "~/.openclaw/archives"
    }
  }
}
```

### 归档流程

```
1. 检测归档条件
   │
   ▼
2. 选择归档数据
   │
   ▼
3. 压缩数据
   │
   ▼
4. 移动到归档目录
   │
   ▼
5. 更新索引
```

---

## 网络发现

### Bonjour 发现

```typescript
// 发现本地服务
const services = await bonjour.discover({
  type: "openclaw",
  protocol: "tcp"
});

// 返回示例
[
  {
    "name": "OpenClaw Gateway",
    "host": "192.168.1.100",
    "port": 8080
  }
]
```

### 配置示例

```json5
{
  "infra": {
    "discovery": {
      "enabled": true,
      "protocols": ["bonjour", "ssdp"],
      "timeout": 5000
    }
  }
}
```

---

## 工具函数

### 文件工具

```typescript
// 安全读取文件
const content = await safeReadFile("/path/to/file");

// 原子写入
await atomicWriteFile("/path/to/file", content);

// 备份后写入
await backupAndWriteFile("/path/to/file", content);
```

### 网络工具

```typescript
// 检查端口
const available = await checkPortAvailable(8080);

// 获取本地 IP
const ip = await getLocalIP();

// 测试连接
const reachable = await testReachability("https://example.com");
```

### 加密工具

```typescript
// 生成密钥
const key = await generateKey();

// 加密数据
const encrypted = await encrypt(data, key);

// 解密数据
const decrypted = await decrypt(encrypted, key);
```

---

## 配置

### 完整 Infra 配置

```json5
{
  "infra": {
    "backup": {
      "enabled": true,
      "interval": "daily",
      "retention": 7,
      "path": "~/.openclaw/backups"
    },
    "archive": {
      "enabled": true,
      "threshold": {
        "age": 30,
        "size": "1GB"
      },
      "compression": "gzip"
    },
    "discovery": {
      "enabled": true,
      "protocols": ["bonjour"]
    },
    "security": {
      "encryptBackups": true,
      "secureDelete": true
    }
  }
}
```

---

*文档版本：1.0 | 更新时间：2026-03-22*
