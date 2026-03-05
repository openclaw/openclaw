# xDAN Findoo Backtest Agent — API 使用指南

> 版本: 2026-03-04 (fep v1.1) | 分支: `dev` | 服务器: `150.109.16.195:8000`

---

## 1. 快速开始

### 1.1 健康检查

```bash
curl http://150.109.16.195:8000/api/v1/health
# → {"status":"ok"}
```

### 1.2 提交回测 (最小示例)

```bash
curl -X POST http://150.109.16.195:8000/api/v1/backtests \
  -H "X-API-Key: <YOUR_KEY>" \
  -F "file=@my-strategy.zip"
# → {"task_id":"bt-xxxxxxxxxxxx","status":"submitted","message":"..."}
```

### 1.3 查询状态

```bash
curl http://150.109.16.195:8000/api/v1/backtests/bt-xxxxxxxxxxxx \
  -H "X-API-Key: <YOUR_KEY>"
```

---

## 2. 鉴权 (Authentication)

所有业务端点需要 `X-API-Key` header。`/health` 无需鉴权。

| 场景 | 行为 |
|------|------|
| 未配置 `BACKTEST_API_KEY` 环境变量 | 跳过鉴权（本地开发模式） |
| 已配置但请求未携带 `X-API-Key` | → `401 Invalid or missing API key` |
| 携带错误 key | → `401` |
| 携带正确 key | → 正常响应 |

### 本地开发 (免鉴权)

```bash
# .env 中留空即可
BACKTEST_API_KEY=
```

### 生产环境

```bash
# .env
BACKTEST_API_KEY=bt-sk-6a25ef85cd8f51b26131da2ee55fe4b2
```

---

## 3. API 端点参考

**Base URL**: `http://<host>:8000/api/v1`

### 3.1 `GET /health` — 健康检查

无需鉴权。

```
200 → {"status": "ok"}
```

### 3.2 `POST /backtests` — 提交回测

上传 ZIP 策略包（`multipart/form-data`）。

**必传参数:**

| 参数 | 类型 | 说明 |
|------|------|------|
| `file` | File | ZIP 策略包 |

**可选覆盖参数 (Form fields):**

| 参数 | 类型 | 说明 |
|------|------|------|
| `symbol` | string | 交易标的，如 `BTC-USD`, `ETH-USD` |
| `initial_capital` | float | 初始资金 |
| `start_date` | string | 回测起始日期 `YYYY-MM-DD` |
| `end_date` | string | 回测结束日期 `YYYY-MM-DD` |
| `engine` | string | 引擎类型: `script` (L1) / `agent` (L2) |
| `budget_cap_usd` | float | L2 Agent 预算上限 (USD) |

**示例 — 覆盖参数:**

```bash
curl -X POST http://150.109.16.195:8000/api/v1/backtests \
  -H "X-API-Key: <KEY>" \
  -F "file=@strategy.zip" \
  -F "symbol=ETH-USD" \
  -F "initial_capital=50000" \
  -F "engine=agent"
```

**响应:**

```json
{
  "task_id": "bt-a1b2c3d4e5f6",
  "status": "submitted",
  "message": "Task submitted"
}
```

**错误响应:**

| HTTP Code | 场景 |
|-----------|------|
| `400` | 非 ZIP 文件、路径穿越、ZIP 解压失败 |
| `401` | API Key 缺失或错误 |
| `422` | 未传 `file` 字段 |

### 3.3 `GET /backtests/{task_id}` — 查询任务状态

```json
{
  "task_id": "bt-a1b2c3d4e5f6",
  "status": "completed",
  "created_at": "2026-03-04T10:00:00",
  "updated_at": "2026-03-04T10:00:30",
  "message": "Backtest completed successfully",
  "reject_reason": null,
  "progress": null,
  "result_summary": {
    "totalReturn": -0.2391,
    "sharpeRatio": -1.82,
    "maxDrawdown": -0.35,
    "totalTrades": 47
  }
}
```

**任务状态机:**

```
submitted → rejected    (校验不通过)
submitted → queued      (校验通过，排队)
queued    → processing  (开始执行)
processing → completed  (回测完成)
processing → failed     (执行异常)
```

### 3.4 `GET /backtests/{task_id}/report` — 获取完整报告

仅 `completed` 状态可用，否则返回 `400`。

```json
{
  "task_id": "bt-a1b2c3d4e5f6",
  "metadata": {
    "id": "fin-trend-following-test",
    "type": "strategy",
    "name": "Trend Following Test Strategy",
    "version": "1.0.0",
    "style": "trend",
    "visibility": "public",
    "summary": "",
    "description": "",
    "tags": [],
    "license": "",
    "changelog": [],
    "author": {},
    "createdAt": "",
    "updatedAt": "",
    "archetype": "",
    "market": "Crypto",
    "assetClasses": [],
    "frequency": "",
    "riskLevel": "medium",
    "parameters": [
      { "name": "sma_fast", "default": 20 },
      { "name": "sma_slow", "default": 50 },
      { "name": "base_amount", "default": 100 }
    ],
    "evolution": {
      "originId": "",
      "parentId": "",
      "forkSource": "",
      "genes": {},
      "mutations": [],
      "lineage": []
    }
  },
  "performance": { "totalReturn": -0.2391, "..." },
  "alpha": null,
  "equity_curve": [{"date": "2024-01-01", "equity": 10000}, "..."],
  "trade_journal": [{"date": "2024-01-08", "action": "buy", "..."}, "..."]
}
```

**`metadata` 字段说明:**

| 字段 | 类型 | 消费方 | 用途 |
|------|------|--------|------|
| `id` / `type` / `name` / `version` | string | 详情卡头部 | 策略标题栏 |
| `style` / `tags` / `market` | string / array | 搜索筛选 | 分类过滤 |
| `visibility` | string | 平台权限 | 公开/私有/未列出 |
| `summary` / `description` | string | 详情卡正文 | 策略介绍 |
| `author` | object | 详情卡作者 | 信任标识 |
| `riskLevel` | string | 详情卡徽章 | 风险可视化 |
| `changelog` | array | 版本历史 | 更新记录 |
| `parameters` | array | 参数面板 | 参数可视化 (含 label/range/group) |
| `evolution` | object | 知识图谱 | 策略血缘溯源 |

> **注意**: `metadata` 从 fep.yaml 提取，不影响回测逻辑。若 fep.yaml 缺失或解析异常，`metadata` 为 `null`，不影响报告其他字段返回。

### 3.5 `GET /backtests` — 分页列出任务

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `limit` | 20 | 每页条数 |
| `offset` | 0 | 偏移量 |

```bash
curl "http://150.109.16.195:8000/api/v1/backtests?limit=5&offset=0" \
  -H "X-API-Key: <KEY>"
```

### 3.6 `DELETE /backtests/{task_id}` — 取消任务

仅排队中 (`queued`) 的任务可取消。

```bash
curl -X DELETE "http://150.109.16.195:8000/api/v1/backtests/bt-xxxx" \
  -H "X-API-Key: <KEY>"
# → {"task_id": "bt-xxxx", "status": "cancelled"}
```

---

## 4. 策略 ZIP 包结构

### 4.1 必要文件

```
my-strategy/
├── fep.yaml           # 策略配置 (必需)
└── scripts/
    └── strategy.py    # 策略代码入口 (必需)
```

### 4.2 fep.yaml 示例

#### 最小配置 (L1 Script)

```yaml
fep: "1.1"

identity:
  id: fin-dca-basic-test          # 唯一标识 (必填)
  type: strategy                  # strategy | indicator | connector
  name: "DCA Basic Test Strategy"
  version: "1.0.0"

technical:
  language: python
  entryPoint: strategy.py         # scripts/ 下的入口文件

backtest:
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
  benchmark: BTC-USD
```

#### 完整配置 (含全部 v1.1 元数据)

```yaml
fep: "1.1"

identity:
  id: fin-dca-adaptive
  type: strategy                  # strategy | indicator | connector
  name: "DCA-Adaptive Strategy"
  version: "1.0.0"
  style: dca                     # trend | mean_reversion | dca | momentum | swing | hybrid
  visibility: public             # public | private | unlisted
  author:
    accountId: "uuid-xxx"
    name: "Alice Chen"
    verified: true
  summary: "一句话简介"
  description: |
    Markdown 格式的详细描述...
  tags: [dca, btc, adaptive, crypto]
  license: MIT
  changelog:
    - version: "1.0.0"
      date: "2026-01-15"
      note: "Initial release"
  createdAt: "2026-01-15T00:00:00Z"
  updatedAt: "2026-03-01T00:00:00Z"

classification:
  archetype: dca-adaptive         # 细分类 (知识图谱用)
  market: Crypto                  # Crypto | US | CN | HK | Forex | Commodity
  assetClasses: [crypto]
  frequency: weekly               # hft | intraday | daily | weekly | monthly

parameters:
  - name: base_amount
    label: "基础定投金额 (USD)"
    description: "每期标准定投金额"
    type: number
    default: 100
    range: { min: 10, max: 10000, step: 10 }
    group: core

technical:
  language: python
  entryPoint: strategy.py

backtest:
  defaultPeriod:
    startDate: "2024-01-01"
    endDate: "2024-12-31"
  initialCapital: 10000
  benchmark: BTC-USD
  commissionRate: 0.001
  slippageRate: 0.0005

risk:
  riskLevel: medium               # low | medium | high
  maxPositionSizePct: 100
  maxDrawdownThreshold: 25
  stopLoss:
    type: trailing
    value: 15

# L2 Agent 专用 (L1 策略可省略)
agent:
  engine: agent
  mode: hybrid                    # script | sample | hybrid | full | research
  budgetCapUsd: 5.0

evolution:                        # 知识图谱谱系 (可选)
  originId: fin-dca-basic
  parentId: fin-dca-v0.9
  genes:
    regime_detection: sma_crossover
  lineage:
    - version: "1.0.0"
      date: "2026-01-15"
      author: "Alice"
      note: "Production ready"
```

### 4.2.1 fep.yaml v1.1 新增字段说明

| 字段 | 位置 | 枚举值 | 默认值 | 用途 |
|------|------|--------|--------|------|
| `type` | identity | strategy / indicator / connector | `strategy` | 条目类型，搜索筛选 |
| `style` | identity | trend / mean_reversion / dca / momentum / swing / hybrid | (空) | 策略风格粗分类 |
| `visibility` | identity | public / private / unlisted | `private` | 平台可见性控制 |
| `description` | identity | Markdown 文本 | (空) | 策略详情卡正文 |
| `tags` | identity | 字符串数组 | `[]` | 标签搜索 |
| `changelog` | identity | `[{version, date, note}]` | `[]` | 版本发布说明 |
| `market` | classification | Crypto / US / CN / HK / Forex / Commodity | (空) | 市场大类筛选 |
| `riskLevel` | risk | low / medium / high | `medium` | 风险等级徽章 |

**向下兼容**: v1.0 的 fep.yaml 无需任何修改即可继续使用，所有新字段均有默认值。

| 旧字段 | 新字段 | 兼容逻辑 |
|--------|--------|----------|
| `identity.entryType` | `identity.type` | 优先读 `type`，fallback 读 `entryType` |
| `classification.riskProfile` | `risk.riskLevel` | 优先读 `riskLevel`，fallback 读 `riskProfile` |

### 4.3 strategy.py 要求

必须实现 `compute(data)` 函数:

```python
def compute(data):
    """
    Args:
        data: pandas DataFrame, 包含 OHLCV 列 (open, high, low, close, volume)
    Returns:
        dict: {"action": "buy"|"sell"|"hold", "amount": float, "price": float, "reason": str}
    """
    close = data["close"].values
    current_price = float(close[-1])
    return {
        "action": "buy",
        "amount": 100.0,
        "price": current_price,
        "reason": f"Buy at ${current_price:.2f}",
    }
```

### 4.4 可选文件

```
my-strategy/
├── fep.yaml
├── scripts/
│   ├── strategy.py
│   ├── risk_manager.py   # 风控模块 (可选)
│   └── indicators.py     # 自定义指标 (可选)
└── data/                  # 自定义数据 (可选)
```

### 4.5 安全限制

以下内容会被安全审查 **拒绝 (rejected)**:

- `import os`, `import subprocess`, `import socket` 等系统模块
- `eval()`, `exec()` 调用
- 文件读写操作 (`open()`)
- 网络请求 (`requests`, `urllib`)
- 混淆导入 (`__import__()`, `importlib`)

**允许的导入:** `numpy`, `pandas`, `math`, `statistics`, `datetime`, `collections`

### 4.6 打包命令

```bash
cd my-strategy/
zip -r ../my-strategy.zip fep.yaml scripts/
```

---

## 5. 完整调试示例 (curl)

```bash
# 0. 设置变量
API="http://150.109.16.195:8000/api/v1"
KEY="your-api-key-here"

# 1. 健康检查
curl -s "$API/health" | python3 -m json.tool

# 2. 上传策略
RESP=$(curl -s -X POST "$API/backtests" \
  -H "X-API-Key: $KEY" \
  -F "file=@my-strategy.zip")
echo "$RESP" | python3 -m json.tool

# 3. 提取 task_id
TASK_ID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['task_id'])")
echo "Task: $TASK_ID"

# 4. 轮询状态 (每 2 秒)
while true; do
  STATUS=$(curl -s "$API/backtests/$TASK_ID" -H "X-API-Key: $KEY")
  S=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  echo "Status: $S"
  if [ "$S" = "completed" ] || [ "$S" = "failed" ] || [ "$S" = "rejected" ]; then
    echo "$STATUS" | python3 -m json.tool
    break
  fi
  sleep 2
done

# 5. 获取完整报告 (仅 completed)
curl -s "$API/backtests/$TASK_ID/report" -H "X-API-Key: $KEY" | python3 -m json.tool
```

---

## 6. 本地开发与测试

### 6.1 环境搭建

```bash
git clone https://github.com/cryptoSUN2049/xDAN-Findoo-backtest-agent.git
cd xDAN-Findoo-backtest-agent
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

### 6.2 运行单元测试

```bash
# 全部测试 (排除 e2e)
uv run pytest tests/ -v -m "not e2e"

# 仅 metadata 测试 (v1.1 元数据 + load_config 回归)
uv run pytest tests/test_metadata.py -v

# 仅鉴权测试
uv run pytest tests/test_auth.py -v

# 仅 API 测试
uv run pytest tests/test_api.py -v

# 仅上传安全测试
uv run pytest tests/test_upload.py -v
```

### 6.3 Docker 启动

```bash
cp deploy/.env.example .env
# 编辑 .env 填入实际值

docker compose -f deploy/docker-compose.yml --env-file .env up -d --build

# 查看日志
docker compose -f deploy/docker-compose.yml --env-file .env logs -f
```

### 6.4 E2E 测试 (需要运行中的服务器)

```bash
# 针对本地 Docker
pytest tests/test_e2e_upload.py -v

# 针对远程服务器
E2E_BASE_URL=http://150.109.16.195:8000 pytest tests/test_e2e_upload.py -v

# 批量 ZIP 测试
bash tests/e2e_batch.sh

# 指定服务器和 API Key
BACKTEST_URL=http://localhost:8000 BACKTEST_API_KEY=your-key bash tests/e2e_batch.sh
```

---

## 7. 测试数据说明

项目包含两套测试数据，覆盖各种正常和异常场景。

### 7.1 `tests/data/strategies/` — 策略源码目录

按类别分组的策略源码，供 `test_e2e_upload.py` 使用。每个子目录可直接打包为 ZIP 上传。

#### valid/ — 合规策略 (期望: completed)

| 目录 | 引擎 | style | market | riskLevel | 说明 |
|------|------|-------|--------|-----------|------|
| `l1-dca-basic` | L1 Script | dca | Crypto | low | 基础定投，每期固定买入 $100 |
| `l1-trend-following` | L1 Script | trend | Crypto | medium | 趋势跟踪 (SMA 交叉) |
| `l1-multi-indicator` | L1 Script | hybrid | Crypto | medium | 多指标 (RSI + MACD + SMA) |
| `l2-agent-adaptive` | L2 Agent | dca | Crypto | medium | 自适应 Agent (需 LLM) |
| `l2-mean-reversion` | L2 Agent | mean_reversion | Crypto | medium | 均值回归 Agent |
| `l2-momentum` | L2 Agent | momentum | Crypto | medium | 动量 Agent |
| `l2-swing-trade` | L2 Agent | swing | Crypto | high | 波段交易 Agent |

#### insecure/ — 不安全策略 (期望: rejected)

| 目录 | 触发规则 | 说明 |
|------|----------|------|
| `import-os` | `import os` | 导入系统模块 |
| `eval-exec` | `eval()` / `exec()` | 动态代码执行 |
| `file-read` | `open()` | 文件读取操作 |
| `network-access` | `import requests` | 网络请求 |
| `subprocess-call` | `import subprocess` | 子进程调用 |
| `obfuscated-import` | `__import__()` | 混淆导入 |

#### incomplete/ — 不完整策略 (期望: rejected)

| 目录 | 缺陷 | 说明 |
|------|------|------|
| `no-fep-yaml` | 缺少 `fep.yaml` | 无配置文件 |
| `empty-strategy` | `strategy.py` 为空 | 空策略代码 |
| `no-scripts` | 缺少 `scripts/` 目录 | 无代码目录 |
| `no-identity` | 缺少 `identity` 字段 | 注意: 当前实现未强制要求，可能通过校验 |

#### malformed/ — 格式错误 (期望: rejected)

| 目录 | 缺陷 | 说明 |
|------|------|------|
| `bad-yaml` | YAML 语法错误 | 无法解析的配置 |
| `bad-python` | Python 语法错误 | 无法编译的代码 |
| `missing-fields` | 缺少必填字段 | `fep.yaml` 不完整 |

#### garbage/ — 垃圾数据 (期望: rejected)

| 目录 | 内容 | 说明 |
|------|------|------|
| `random-content` | 随机文本 | 非策略内容 |
| `binary-files` | 二进制数据 | 非文本文件 |

#### edge/ — 边界场景 (期望: completed)

| 目录 | 特点 | 说明 |
|------|------|------|
| `deep-nesting` | 多层嵌套目录 | `scripts/lib/utils/helpers/` |
| `large-code` | 大量代码 | 较大的策略文件 |

### 7.2 `tests/data/zips/` — 预构建 ZIP 文件

24 个预打包的 ZIP 文件，供 `e2e_batch.sh` 批量测试使用。

**命名规则:** `<category>--<name>.zip`

- `category`: `valid`, `insecure`, `incomplete`, `malformed`, `garbage`, `edge`
- `name`: 策略名称

**文件列表:**

```
valid--l1-dca-basic.zip          valid--l2-agent-adaptive.zip
valid--l1-multi-indicator.zip    valid--l2-mean-reversion.zip
valid--l1-trend-following.zip    valid--l2-momentum.zip
                                 valid--l2-swing-trade.zip

insecure--import-os.zip          insecure--network-access.zip
insecure--eval-exec.zip          insecure--subprocess-call.zip
insecure--file-read.zip          insecure--obfuscated-import.zip

incomplete--no-fep-yaml.zip      incomplete--no-scripts.zip
incomplete--empty-strategy.zip   incomplete--no-identity.zip

malformed--bad-yaml.zip          malformed--missing-fields.zip
malformed--bad-python.zip

garbage--random-content.zip      garbage--binary-files.zip

edge--deep-nesting.zip           edge--large-code.zip
```

### 7.3 期望结果映射

| 类别 | 期望状态 | 说明 |
|------|----------|------|
| `valid` | `completed` | 通过校验 + 执行完成 |
| `insecure` | `rejected` | 安全审查拦截 |
| `incomplete` | `rejected` | 结构校验拦截 |
| `malformed` | `rejected` | 配置解析拦截 |
| `garbage` | `rejected` | 内容校验拦截 |
| `edge` | `completed` | 边界场景应正常通过 |

### 7.4 添加新测试用例

```bash
# 1. 创建策略目录
mkdir -p tests/data/strategies/<category>/<name>/scripts

# 2. 添加 fep.yaml 和 strategy.py
# ...

# 3. 打包为 ZIP (存入 zips/)
cd tests/data/strategies/<category>/<name>
zip -r ../../../zips/<category>--<name>.zip fep.yaml scripts/

# 4. 运行批量测试验证
bash tests/e2e_batch.sh
```

---

## 8. 服务器部署

### 8.1 首次部署

```bash
ssh root@150.109.16.195
cd /home/xDAN-Findoo-backtest-agent

# 拉取代码
git pull origin dev

# 配置环境变量
cp deploy/.env.example .env
vim .env  # 填入实际值

# 启动
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

### 8.2 更新部署

```bash
ssh root@150.109.16.195
cd /home/xDAN-Findoo-backtest-agent

git pull origin dev
docker compose -f deploy/docker-compose.yml --env-file .env up -d --build
```

### 8.3 常用运维命令

```bash
# 查看日志
docker compose -f deploy/docker-compose.yml --env-file .env logs -f

# 重启服务
docker compose -f deploy/docker-compose.yml --env-file .env restart

# 停止服务
docker compose -f deploy/docker-compose.yml --env-file .env down

# 清理磁盘 (慎用)
docker system prune -f --volumes
```

---

## 9. 常见问题 (FAQ)

### Q1: 上传返回 401

请求未携带 `X-API-Key` header，或 key 不正确。

```bash
# 检查是否携带了正确的 header
curl -v -H "X-API-Key: <YOUR_KEY>" http://150.109.16.195:8000/api/v1/backtests
```

### Q2: 上传返回 400 "ZIP"

文件不是有效的 ZIP 格式，或包含路径穿越。确保使用 `zip` 命令正确打包。

### Q3: 状态停在 submitted 不动

Worker 可能未启动或全部繁忙。检查容器日志:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env logs -f backtest-agent
```

### Q4: 状态为 rejected

查看 `reject_reason` 字段，常见原因:
- 安全审查不通过 (禁止的 import/函数)
- 缺少 `fep.yaml` 或 `scripts/strategy.py`
- YAML 解析错误
- 缺少必填字段

### Q5: 状态为 failed

策略代码执行出错。查看日志中的异常信息，常见原因:
- `strategy.py` 中 `compute()` 函数抛异常
- 数据格式不匹配
- 缺少依赖的 Python 包

### Q6: L2 Agent 策略超时或失败

L2 引擎依赖 LLM API (LiteLLM Proxy)，可能因:
- API Key 未配置或已过期
- LLM 服务不可用
- `budget_cap_usd` 设置过低

### Q7: 磁盘空间不足 (OSError: No space left)

```bash
# 清理 Docker 缓存
docker system prune -f --volumes
# 检查磁盘
df -h
```

---

