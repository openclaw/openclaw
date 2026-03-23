# Memory 核心模块详解

> Memory 提供长期记忆功能，支持向量化存储、语义搜索、批量嵌入等。

## 目录

1. [Memory 概述](#memory-概述)
2. [架构设计](#架构设计)
3. [存储后端](#存储后端)
4. [批量嵌入](#批量嵌入)
5. [使用示例](#使用示例)

---

## Memory 概述

### 什么是 Memory？

**Memory = 长期记忆系统**

它可以：
- 🧠 **向量化存储**：将文本转换为向量
- 🔍 **语义搜索**：根据意思搜索，不只是关键词
- 📦 **批量处理**：高效处理大量数据
- 💾 **持久化**：数据持久存储

---

## 架构设计

### 组件图

```
Memory
│
├── Backend (后端)
│   ├── LanceDB (向量数据库)
│   ├── SQLite (关系数据库)
│   └── File System (文件系统)
│
├── Embedding (嵌入)
│   ├── OpenAI Embedding
│   ├── Gemini Embedding
│   └── HTTP Embedding
│
├── Batch (批量)
│   ├── Batch Runner (批量运行器)
│   ├── Batch Status (状态管理)
│   └── Error Handling (错误处理)
│
└── API (接口)
    ├── Store (存储)
    ├── Search (搜索)
    └── Delete (删除)
```

### 文件结构

```
src/memory/
├── backend-config.ts           # 后端配置
├── batch-gemini.ts             # Gemini 批量嵌入
├── batch-openai.ts             # OpenAI 批量嵌入
├── batch-runner.ts             # 批量运行器
├── batch-status.ts             # 批量状态
└── embedding-*.ts              # 嵌入实现
```

---

## 存储后端

### LanceDB

```typescript
// 配置示例
{
  "memory": {
    "backend": {
      "type": "lancedb",
      "path": "~/.openclaw/memory",
      "table": "memories"
    }
  }
}
```

**特点**：
- ✅ 向量搜索
- ✅ 本地存储
- ✅ 高性能

### SQLite

```typescript
// 配置示例
{
  "memory": {
    "backend": {
      "type": "sqlite",
      "path": "~/.openclaw/memory.db"
    }
  }
}
```

**特点**：
- ✅ 关系查询
- ✅ 事务支持
- ✅ 成熟稳定

---

## 批量嵌入

### OpenAI 批量嵌入

```typescript
// 配置
{
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "batchSize": 100
  }
}

// 使用
const batch = await createBatchEmbedding({
  texts: ["文本 1", "文本 2", ...],
  provider: "openai"
});

// 等待完成
const status = await getBatchStatus(batch.id);
```

### Gemini 批量嵌入

```typescript
// 配置
{
  "embedding": {
    "provider": "gemini",
    "model": "text-embedding-004",
    "batchSize": 100
  }
}
```

### 批量状态

| 状态 | 说明 |
|------|------|
| `pending` | 等待处理 |
| `processing` | 处理中 |
| `completed` | 完成 |
| `failed` | 失败 |

---

## 使用示例

### 1. 存储记忆

```typescript
await memory.store({
  content: "今天天气不错",
  metadata: {
    date: "2026-03-22",
    mood: "happy"
  }
});
```

### 2. 搜索记忆

```typescript
// 语义搜索
const results = await memory.search({
  query: "开心的日子",
  limit: 5
});

// 返回示例
[
  {
    "content": "今天天气不错",
    "score": 0.85,
    "metadata": { "date": "2026-03-22", "mood": "happy" }
  }
]
```

### 3. 批量存储

```typescript
const batch = await memory.batchStore([
  { content: "记忆 1" },
  { content: "记忆 2" },
  { content: "记忆 3" }
]);

// 等待完成
await batch.waitForCompletion();
```

### 4. 删除记忆

```typescript
// 按 ID 删除
await memory.delete("memory-id-123");

// 按条件删除
await memory.deleteWhere({
  metadata: { date: "2026-03-21" }
});
```

---

## 配置

### 完整配置示例

```json5
{
  "memory": {
    "enabled": true,
    "backend": {
      "type": "lancedb",
      "path": "~/.openclaw/memory"
    },
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dimensions": 1536,
      "batchSize": 100
    },
    "retention": {
      "maxItems": 10000,
      "maxAgeDays": 365
    }
  }
}
```

---

*文档版本：1.0 | 更新时间：2026-03-22*
