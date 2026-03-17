# Hub API 接口规范 - 策略 Fork 模块

> 版本: 1.0.0  
> 日期: 2026-03-16  
> 用于: hub.openfinclaw.ai 后端开发

## 概述

本文档定义策略 Fork 模块所需的 Hub API 端点，供后端开发参考。

---

## 1. 获取策略详情

获取单个策略的完整信息，包括元数据和绩效指标。

### 请求

```
GET /api/v1/skill/{id}
```

### 路径参数

| 参数 | 类型   | 必填 | 说明                 |
| ---- | ------ | ---- | -------------------- |
| `id` | string | 是   | 策略 ID（UUID 格式） |

### 请求头

| Header          | 必填 | 说明                                           |
| --------------- | ---- | ---------------------------------------------- |
| `Authorization` | 否   | Bearer Token（公开策略无需认证，私有策略需要） |

### 响应

#### 成功响应 (200 OK)

```json
{
  "id": "34a5792f-7d20-4a15-90f3-26f1c54fa4a6",
  "name": "BTC Adaptive DCA",
  "slug": "btc-adaptive-dca",
  "version": "1.0.0",
  "author": {
    "id": "user-xxx",
    "name": "黄吕靖"
  },
  "description": "Adaptive DCA strategy for BTC with dynamic position sizing based on market conditions.",
  "tags": ["dca", "btc", "adaptive", "crypto"],
  "market": "Crypto",
  "visibility": "public",
  "performance": {
    "totalReturn": 2.43,
    "annualizedReturn": 1.85,
    "sharpe": 0.11,
    "sortino": 0.15,
    "calmar": 0.03,
    "maxDrawdown": -37.23,
    "winRate": 0.52,
    "profitFactor": 1.23,
    "totalTrades": 156,
    "finalEquity": 34280.5
  },
  "createdAt": "2026-03-01T00:00:00Z",
  "updatedAt": "2026-03-15T00:00:00Z",
  "downloadCount": 42
}
```

#### 错误响应

| 状态码 | 说明                             |
| ------ | -------------------------------- |
| 404    | 策略不存在                       |
| 403    | 无权限访问（私有策略且非所有者） |

```json
{
  "code": "NOT_FOUND",
  "message": "Strategy not found"
}
```

### 字段说明

| 字段                      | 类型     | 必返回 | 说明                                          |
| ------------------------- | -------- | ------ | --------------------------------------------- |
| `id`                      | string   | 是     | 策略 UUID                                     |
| `name`                    | string   | 是     | 策略显示名称                                  |
| `slug`                    | string   | 否     | URL 友好名称                                  |
| `version`                 | string   | 是     | 当前版本号                                    |
| `author.id`               | string   | 否     | 作者用户 ID                                   |
| `author.name`             | string   | 否     | 作者显示名称                                  |
| `description`             | string   | 否     | 策略描述                                      |
| `tags`                    | string[] | 否     | 标签列表                                      |
| `market`                  | string   | 否     | 市场：`Crypto` / `US` / `HK` / `CN` / `Forex` |
| `visibility`              | string   | 是     | 可见性：`public` / `private` / `unlisted`     |
| `performance`             | object   | 否     | 绩效指标（回测完成后填充）                    |
| `performance.totalReturn` | number   | 否     | 总收益率（小数，如 2.43 = +243%）             |
| `performance.sharpe`      | number   | 否     | 夏普比率                                      |
| `performance.maxDrawdown` | number   | 否     | 最大回撤（负数，如 -0.37 = -37%）             |
| `performance.winRate`     | number   | 否     | 胜率（0-1 之间）                              |
| `performance.totalTrades` | number   | 否     | 交易笔数                                      |
| `createdAt`               | string   | 是     | 创建时间（ISO 8601）                          |
| `updatedAt`               | string   | 否     | 更新时间（ISO 8601）                          |
| `downloadCount`           | number   | 否     | 下载次数                                      |

---

## 2. 下载策略包

下载策略的完整 ZIP 包，包含 `fep.yaml` 和 `scripts/strategy.py`。

### 请求

```
GET /api/v1/skill/{id}/download
```

### 路径参数

| 参数 | 类型   | 必填 | 说明                 |
| ---- | ------ | ---- | -------------------- |
| `id` | string | 是   | 策略 ID（UUID 格式） |

### 请求头

| Header          | 必填 | 说明                             |
| --------------- | ---- | -------------------------------- |
| `Authorization` | 否   | Bearer Token（公开策略无需认证） |

### 响应

#### 成功响应 (200 OK)

| Header                | 值                                            |
| --------------------- | --------------------------------------------- |
| `Content-Type`        | `application/zip`                             |
| `Content-Disposition` | `attachment; filename="{slug}-{version}.zip"` |

响应体为二进制 ZIP 文件。

#### ZIP 文件结构

```
{slug}-{version}.zip
├── fep.yaml              # 策略配置文件（FEP v1.2 格式）
└── scripts/
    └── strategy.py       # 策略代码
```

#### 示例 ZIP 内容

**fep.yaml:**

```yaml
fep: "1.2"

identity:
  id: btc-adaptive-dca
  name: BTC Adaptive DCA
  type: strategy
  version: "1.0.0"
  style: trend
  visibility: public
  summary: Adaptive DCA strategy for BTC
  license: MIT
  author:
    name: 黄吕靖
  tags:
    - dca
    - btc
    - adaptive
    - crypto

technical:
  language: python
  entryPoint: strategy.py

classification:
  assetClasses:
    - crypto
  markets:
    - crypto
  instruments:
    - BTC-USD
  timeframes:
    - 1d

backtest:
  defaultPeriod:
    startDate: "2020-01-01"
    endDate: "2025-12-31"
  initialCapital: 10000
  benchmark: BTC-USD
```

**scripts/strategy.py:**

```python
def compute(data):
    """
    Main strategy compute function.

    Args:
        data: Dict with OHLCV data and current state

    Returns:
        Dict with action, amount, price, reason
    """
    # Strategy logic here
    return {
        "action": "hold",
        "amount": 0,
        "price": None,
        "reason": "No signal"
    }
```

#### 错误响应

| 状态码 | 说明                   |
| ------ | ---------------------- |
| 404    | 策略不存在             |
| 403    | 无权限下载（私有策略） |
| 410    | 策略已下架             |

```json
{
  "code": "NOT_FOUND",
  "message": "Strategy not found"
}
```

---

## 3. 搜索策略（可选）

搜索和筛选公开策略列表。

### 请求

```
GET /api/v1/skills
```

### 查询参数

| 参数     | 类型    | 必填 | 默认值      | 说明                                                          |
| -------- | ------- | ---- | ----------- | ------------------------------------------------------------- |
| `page`   | integer | 否   | 1           | 页码                                                          |
| `limit`  | integer | 否   | 20          | 每页数量（最大 100）                                          |
| `market` | string  | 否   | -           | 市场筛选：`crypto` / `us` / `hk` / `cn`                       |
| `sort`   | string  | 否   | `createdAt` | 排序字段：`return` / `sharpe` / `createdAt` / `downloadCount` |
| `order`  | string  | 否   | `desc`      | 排序方向：`asc` / `desc`                                      |
| `search` | string  | 否   | -           | 搜索关键词（名称、描述）                                      |

### 响应

```json
{
  "items": [
    {
      "id": "34a5792f-7d20-4a15-90f3-26f1c54fa4a6",
      "name": "BTC Adaptive DCA",
      "slug": "btc-adaptive-dca",
      "version": "1.0.0",
      "author": {
        "name": "黄吕靖"
      },
      "market": "Crypto",
      "performance": {
        "totalReturn": 2.43,
        "sharpe": 0.11
      },
      "createdAt": "2026-03-01T00:00:00Z"
    }
  ],
  "total": 150,
  "page": 1,
  "limit": 20,
  "totalPages": 8
}
```

---

## 4. 实现建议

### 4.1 缓存策略

| 端点                       | 缓存建议                          |
| -------------------------- | --------------------------------- |
| `GET /skill/{id}`          | 缓存 5 分钟（策略信息变化不频繁） |
| `GET /skill/{id}/download` | 缓存 ZIP 文件，使用 ETag          |
| `GET /skills`              | 缓存 1 分钟                       |

### 4.2 下载统计

`GET /skill/{id}/download` 成功调用后，应递增 `downloadCount` 字段。

### 4.3 权限控制

| visibility | 访问规则                           |
| ---------- | ---------------------------------- |
| `public`   | 任何人可访问和下载                 |
| `private`  | 仅作者可访问                       |
| `unlisted` | 知道 ID 可访问，但不出现在搜索结果 |

### 4.4 ZIP 生成

建议预先生成 ZIP 文件并缓存，避免每次下载时动态打包。

---

## 5. 客户端调用示例

### 5.1 获取策略信息

```bash
curl -X GET "https://hub.openfinclaw.ai/api/v1/skill/34a5792f-7d20-4a15-90f3-26f1c54fa4a6" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 5.2 下载策略包

```bash
curl -X GET "https://hub.openfinclaw.ai/api/v1/skill/34a5792f-7d20-4a15-90f3-26f1c54fa4a6/download" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -o strategy.zip
```

### 5.3 搜索策略

```bash
curl -X GET "https://hub.openfinclaw.ai/api/v1/skills?market=crypto&sort=return&limit=10"
```

---

## 6. 错误码定义

| HTTP 状态码 | 错误码            | 说明            |
| ----------- | ----------------- | --------------- |
| 400         | `INVALID_REQUEST` | 请求参数无效    |
| 401         | `UNAUTHORIZED`    | 未认证          |
| 403         | `FORBIDDEN`       | 无权限          |
| 404         | `NOT_FOUND`       | 资源不存在      |
| 410         | `GONE`            | 资源已删除/下架 |
| 429         | `RATE_LIMITED`    | 请求频率超限    |
| 500         | `INTERNAL_ERROR`  | 服务器内部错误  |

---

## 7. 相关文档

- [策略 Fork 模块设计文档](./strategy-fork-module-design.md)
- [FEP v1.2 规范](./fep-v1.2-reference.yaml)
