# Hub API 接口规范 - 策略 Fork 模块

> 版本: 1.1.0  
> 日期: 2026-03-17  
> 用于: hub.openfinclaw.ai 后端开发

## 概述

本文档定义策略 Fork 模块所需的 Hub API 端点，供后端开发参考。

---

## 1. 公开策略详情

获取单个公开策略的完整信息。无需认证即可访问公开策略。

### 请求

```
GET /api/v1/skill/public/{id}
```

### 路径参数

| 参数 | 类型   | 必填 | 说明                 |
| ---- | ------ | ---- | -------------------- |
| `id` | string | 是   | 策略 ID（UUID 格式） |

### 请求头

| Header          | 必填 | 说明                                             |
| --------------- | ---- | ------------------------------------------------ |
| `Authorization` | 否   | Bearer Token（可选，带认证可查看自己的私有策略） |
| `Accept`        | 否   | `application/json`                               |

### 查询参数

| 参数      | 类型   | 必填 | 说明                        |
| --------- | ------ | ---- | --------------------------- |
| `noCache` | string | 否   | 设为 `1` 绕过缓存，实时查询 |

### 响应

#### 成功响应 (200 OK)

```json
{
  "id": "abc123",
  "slug": "smart-rebalancer",
  "name": "Smart Rebalancer",
  "description": "基于均值回归的智能再平衡策略...",
  "summary": "智能再平衡策略摘要",
  "type": "strategy",
  "tags": ["rebalance", "mean-reversion"],
  "version": "1.2.0",
  "visibility": "public",
  "tier": "gold",
  "author": {
    "id": "user-uuid",
    "slug": "alice",
    "displayName": "Alice",
    "verified": true
  },
  "stats": {
    "fcsScore": 82.5,
    "forkCount": 8,
    "downloadCount": 1024,
    "viewCount": 5678
  },
  "backtestResult": {
    "sharpe": 1.85,
    "totalReturn": 0.342,
    "maxDrawdown": -0.128,
    "winRate": 0.623
  },
  "createdAt": "2025-11-20T08:00:00Z",
  "updatedAt": "2026-02-15T10:30:00Z"
}
```

#### 错误响应

| 状态码 | 错误码            | 说明               |
| ------ | ----------------- | ------------------ |
| 404    | `ENTRY_NOT_FOUND` | 策略不存在或非公开 |

```json
{
  "error": {
    "code": "ENTRY_NOT_FOUND",
    "message": "Strategy not found"
  }
}
```

### 字段说明

| 字段                         | 类型     | 必返回 | 说明                                            |
| ---------------------------- | -------- | ------ | ----------------------------------------------- |
| `id`                         | string   | 是     | 策略 UUID                                       |
| `slug`                       | string   | 否     | URL 友好名称                                    |
| `name`                       | string   | 是     | 策略显示名称                                    |
| `description`                | string   | 否     | 策略详细描述                                    |
| `summary`                    | string   | 否     | 策略摘要                                        |
| `type`                       | string   | 否     | 类型：`strategy`                                |
| `tags`                       | string[] | 否     | 标签列表                                        |
| `version`                    | string   | 是     | 当前版本号                                      |
| `visibility`                 | string   | 是     | 可见性：`public` / `private` / `unlisted`       |
| `tier`                       | string   | 否     | 等级：`bronze` / `silver` / `gold` / `platinum` |
| `author.id`                  | string   | 否     | 作者用户 ID                                     |
| `author.slug`                | string   | 否     | 作者 slug                                       |
| `author.displayName`         | string   | 否     | 作者显示名称                                    |
| `author.verified`            | boolean  | 否     | 作者是否已认证                                  |
| `stats.fcsScore`             | number   | 否     | FCS 评分                                        |
| `stats.forkCount`            | number   | 否     | Fork 次数                                       |
| `stats.downloadCount`        | number   | 否     | 下载次数                                        |
| `stats.viewCount`            | number   | 否     | 查看次数                                        |
| `backtestResult.sharpe`      | number   | 否     | 夏普比率                                        |
| `backtestResult.totalReturn` | number   | 否     | 总收益率（小数，如 0.342 = +34.2%）             |
| `backtestResult.maxDrawdown` | number   | 否     | 最大回撤（负数，如 -0.128 = -12.8%）            |
| `backtestResult.winRate`     | number   | 否     | 胜率（0-1 之间）                                |
| `createdAt`                  | string   | 是     | 创建时间（ISO 8601）                            |
| `updatedAt`                  | string   | 否     | 更新时间（ISO 8601）                            |

### 缓存策略

| 场景       | 缓存                         |
| ---------- | ---------------------------- |
| 无 API Key | 5 分钟缓存                   |
| 带 API Key | 不使用缓存（可查看私有策略） |

---

## 2. Fork 并下载策略包（AI Agent 专用）

Fork 策略并获取下载链接，专为 AI Agent 设计。

### 请求

```
POST /api/v1/skill/entries/{id}/fork-and-download
```

### 路径参数

| 参数 | 类型   | 必填 | 说明                   |
| ---- | ------ | ---- | ---------------------- |
| `id` | string | 是   | 父策略 ID（UUID 格式） |

### 请求头

| Header          | 必填 | 说明                              |
| --------------- | ---- | --------------------------------- |
| `Authorization` | 是   | Bearer Token（需要 `full` scope） |
| `Content-Type`  | 是   | `application/json`                |

### 请求体

```json
{
  "name": "My Smart Rebalancer Fork",
  "slug": "my-smart-rebalancer",
  "description": "Customized version",
  "forkConfig": {
    "keepGenes": true,
    "overrideParams": {}
  }
}
```

| 字段                        | 类型    | 必填 | 说明                                     |
| --------------------------- | ------- | ---- | ---------------------------------------- |
| `name`                      | string  | 否   | Fork 后的策略名称，默认原名称 + "(Fork)" |
| `slug`                      | string  | 否   | Fork 后的 slug，默认自动生成             |
| `description`               | string  | 否   | 描述，默认继承原策略                     |
| `forkConfig.keepGenes`      | boolean | 否   | 是否继承基因组合，默认 `true`            |
| `forkConfig.overrideParams` | object  | 否   | 覆盖参数                                 |

### 响应

#### 成功响应 (201 Created)

```json
{
  "success": true,
  "entry": {
    "id": "new-entry-uuid",
    "slug": "my-smart-rebalancer",
    "name": "My Smart Rebalancer Fork",
    "version": "1.0.0"
  },
  "parent": {
    "id": "abc123",
    "slug": "smart-rebalancer",
    "name": "Smart Rebalancer"
  },
  "download": {
    "url": "https://storage.example.com/...",
    "filename": "my-smart-rebalancer-v1.0.0.zip",
    "expiresInSeconds": 3600,
    "contentHash": "sha256:abc123..."
  },
  "forkedAt": "2026-03-17T10:00:00Z",
  "creditsEarned": {
    "action": "fork",
    "amount": 10,
    "message": "You earned 10 FC. Author @alice earned 15 FC royalty."
  }
}
```

#### 错误响应

| HTTP 状态码 | 错误码               | 说明                                  |
| ----------- | -------------------- | ------------------------------------- |
| 401         | `MISSING_API_KEY`    | 未提供 API Key                        |
| 403         | `INSUFFICIENT_SCOPE` | API Key 权限不足（需要 `full` scope） |
| 404         | `ENTRY_NOT_FOUND`    | 策略不存在或非公开                    |
| 409         | `SLUG_CONFLICT`      | slug 已被占用                         |
| 504         | `VALIDATION_ERROR`   | Fork 处理超时（超过 120 秒）          |

```json
{
  "error": {
    "code": "INSUFFICIENT_SCOPE",
    "message": "API key requires 'full' scope for fork operation"
  }
}
```

### 响应字段说明

| 字段                        | 类型    | 说明                          |
| --------------------------- | ------- | ----------------------------- |
| `success`                   | boolean | 操作是否成功                  |
| `entry.id`                  | string  | Fork 后的策略 ID              |
| `entry.slug`                | string  | Fork 后的策略 slug            |
| `entry.name`                | string  | Fork 后的策略名称             |
| `entry.version`             | string  | Fork 后的版本号               |
| `parent.id`                 | string  | 原策略 ID                     |
| `parent.slug`               | string  | 原策略 slug                   |
| `parent.name`               | string  | 原策略名称                    |
| `download.url`              | string  | 签名下载 URL（有效期 1 小时） |
| `download.filename`         | string  | ZIP 文件名                    |
| `download.expiresInSeconds` | number  | 下载链接有效期（秒）          |
| `download.contentHash`      | string  | 内容哈希                      |
| `forkedAt`                  | string  | Fork 时间（ISO 8601）         |
| `creditsEarned.action`      | string  | 操作类型                      |
| `creditsEarned.amount`      | number  | 获得积分                      |
| `creditsEarned.message`     | string  | 积分说明                      |

### Fork 类型与 Genetic Graph 节点对应

| fork_type | 显示颜色 | 说明                             |
| --------- | -------- | -------------------------------- |
| `root`    | 灰色     | 原始策略（无父节点）             |
| `manual`  | 蓝色     | 用户通过 Web 页面手动 Fork       |
| `agent`   | 紫色     | AI Agent 通过 API Fork（本接口） |
| `auto`    | 绿色     | 系统自动 Fork（实验性功能）      |

---

## 3. 客户端调用示例

### 3.1 获取策略信息

```bash
# 查询公开策略详情（无需认证）
curl -X GET "https://hub.openfinclaw.ai/api/v1/skill/public/abc123" \
  -H "Accept: application/json"

# 带 API Key 访问（可查看自己的私有策略）
curl -X GET "https://hub.openfinclaw.ai/api/v1/skill/public/abc123" \
  -H "Authorization: Bearer fch_your_api_key" \
  -H "Accept: application/json"

# 绕过缓存
curl -X GET "https://hub.openfinclaw.ai/api/v1/skill/public/abc123?noCache=1"
```

### 3.2 Fork 并下载

```bash
# Fork 策略并获取下载链接
curl -X POST "https://hub.openfinclaw.ai/api/v1/skill/entries/abc123/fork-and-download" \
  -H "Authorization: Bearer fch_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Forked Strategy",
    "slug": "my-forked-strategy",
    "description": "Forked for customization",
    "forkConfig": {
      "keepGenes": true
    }
  }'

# 仅指定名称（slug 自动生成）
curl -X POST "https://hub.openfinclaw.ai/api/v1/skill/entries/abc123/fork-and-download" \
  -H "Authorization: Bearer fch_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Strategy Fork"}'
```

### 3.3 TypeScript 调用示例

```typescript
import fetch from "node-fetch";

const HUB_API = "https://hub.openfinclaw.ai";
const API_KEY = process.env.SKILL_API_KEY; // fch_xxx

/**
 * 获取公开策略详情
 */
async function getPublicEntry(entryId: string, noCache = false) {
  const url = `${HUB_API}/api/v1/skill/public/${entryId}${noCache ? "?noCache=1" : ""}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Failed to fetch entry");
  }

  return response.json();
}

/**
 * Fork 策略并获取下载链接
 */
async function forkAndDownload(
  entryId: string,
  options: {
    name?: string;
    slug?: string;
    description?: string;
    keepGenes?: boolean;
  } = {},
) {
  const url = `${HUB_API}/api/v1/skill/entries/${entryId}/fork-and-download`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: options.name,
      slug: options.slug,
      description: options.description,
      forkConfig: {
        keepGenes: options.keepGenes ?? true,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Fork failed");
  }

  return response.json();
}

// 使用示例
async function main() {
  // 1. 获取策略详情
  const entry = await getPublicEntry("abc123");
  console.log("Strategy:", entry.name, "by", entry.author?.displayName);

  // 2. Fork 并下载
  const result = await forkAndDownload("abc123", {
    name: "My Custom Strategy",
  });

  console.log("Forked:", result.entry.name);
  console.log("Download URL:", result.download.url);

  // 3. 下载 ZIP
  const zipResponse = await fetch(result.download.url);
  const buffer = await zipResponse.buffer();
  // 保存到本地
  require("fs").writeFileSync(result.download.filename, buffer);
}
```

---

## 4. 错误码定义

| HTTP 状态码 | 错误码               | 说明             |
| ----------- | -------------------- | ---------------- |
| 400         | `INVALID_REQUEST`    | 请求参数无效     |
| 401         | `MISSING_API_KEY`    | 未提供 API Key   |
| 403         | `INSUFFICIENT_SCOPE` | API Key 权限不足 |
| 404         | `ENTRY_NOT_FOUND`    | 策略不存在       |
| 409         | `SLUG_CONFLICT`      | slug 冲突        |
| 429         | `RATE_LIMITED`       | 请求频率超限     |
| 500         | `INTERNAL_ERROR`     | 服务器内部错误   |
| 504         | `VALIDATION_ERROR`   | 处理超时         |

---

## 5. 相关文档

- [策略 Fork 模块设计文档](./strategy-fork-module-design.md)
- [FEP v1.2 规范](./fep-v1.2-reference.yaml)
