# 策略 Fork 模块设计文档

> 版本: 1.0.0  
> 日期: 2026-03-16  
> 状态: 设计中

## 1. 概述

本文档描述 `openfinclaw` 策略 fork 模块的设计，用于从 `hub.openfinclaw.ai` 下载公开策略到本地，支持用户基于现有策略进行二次开发和优化。

### 1.1 背景

- Hub 上已有大量公开策略可供用户学习参考
- 用户希望能够下载策略到本地进行修改和优化
- 需要一个易用的 CLI 工具和 AI 工具支持策略 fork 流程

### 1.2 设计目标

- **语义化命名**: 使用策略名称而非 UUID 作为目录名
- **时间组织**: 按日期组织策略目录，保持目录整洁
- **冲突处理**: 自动处理同名策略冲突
- **易用性**: 提供直观的 CLI 命令和 AI 工具

---

## 2. 目录结构

### 2.1 基础结构

```
~/.openfinclaw/strategies/
└── 2026-03-16/                              # 按日期组织（下载/创建日期）
    ├── btc-adaptive-dca-34a5792f/           # Fork 来的策略：名称 + 短ID
    │   ├── fep.yaml                         # 策略配置文件
    │   ├── scripts/
    │   │   └── strategy.py                  # 策略代码
    │   └── .fork-meta.json                  # Fork 元数据
    ├── eth-trend-following-a8b32c1d/        # 另一个 fork 的策略
    │   └── ...
    └── my-new-strategy/                     # 用户创建的策略（无短ID后缀）
        ├── fep.yaml
        ├── scripts/
        │   └── strategy.py
        └── .created-meta.json               # 创建元数据
```

### 2.2 命名规则

| 类型      | 格式                          | 示例                        |
| --------- | ----------------------------- | --------------------------- |
| Fork 策略 | `{slugified-name}-{short-id}` | `btc-adaptive-dca-34a5792f` |
| 自建策略  | `{slugified-name}`            | `my-btc-strategy`           |

**Slugify 规则:**

- 转小写: `BTC Adaptive DCA` → `btc adaptive dca`
- 空格/下划线转连字符: `btc adaptive dca` → `btc-adaptive-dca`
- 移除特殊字符（只保留字母、数字、连字符）
- 限制长度: 最长 40 字符
- 短 ID: 取 Hub 策略 ID 的前 8 位

---

## 3. 元数据文件

### 3.1 `.fork-meta.json` (Fork 策略)

```json
{
  "sourceId": "34a5792f-7d20-4a15-90f3-26f1c54fa4a6",
  "sourceShortId": "34a5792f",
  "sourceName": "BTC Adaptive DCA",
  "sourceVersion": "1.0.0",
  "sourceAuthor": "黄吕靖",
  "forkedAt": "2026-03-16T10:00:00Z",
  "forkDateDir": "2026-03-16",
  "hubUrl": "https://hub.openfinclaw.ai/strategy/34a5792f-7d20-4a15-90f3-26f1c54fa4a6",
  "localPath": "~/.openfinclaw/strategies/2026-03-16/btc-adaptive-dca-34a5792f"
}
```

### 3.2 `.created-meta.json` (自建策略)

```json
{
  "name": "my-btc-strategy",
  "displayName": "My BTC Strategy",
  "createdAt": "2026-03-16T10:30:00Z",
  "createDateDir": "2026-03-16",
  "localPath": "~/.openfinclaw/strategies/2026-03-16/my-btc-strategy",
  "versions": [
    {
      "version": "1.0.0",
      "publishedAt": "2026-03-16T11:00:00Z",
      "hubId": "abc123...",
      "hubSlug": "my-btc-strategy"
    }
  ]
}
```

---

## 4. CLI 命令设计

### 4.1 命令概览

| 命令                                   | 说明                   |
| -------------------------------------- | ---------------------- |
| `openfinclaw strategy fork <id>`       | 从 Hub fork 策略到本地 |
| `openfinclaw strategy create <name>`   | 创建新策略             |
| `openfinclaw strategy list`            | 列出本地策略           |
| `openfinclaw strategy show <id>`       | 查看策略详情           |
| `openfinclaw strategy validate <path>` | 验证策略包             |
| `openfinclaw strategy remove <id>`     | 删除本地策略           |

### 4.2 `strategy fork`

从 Hub 下载策略到本地。

**用法:**

```bash
openfinclaw strategy fork <strategy-id> [options]
```

**参数:**

- `<strategy-id>`: Hub 策略 ID（支持完整 UUID、短 ID、或 Hub URL）

**选项:**

- `--dir <path>`: 自定义目标路径（跳过日期组织）
- `--date <date>`: 指定日期目录（默认今天，格式 YYYY-MM-DD）
- `--yes, -y`: 跳过确认提示

**示例:**

```bash
# 使用完整 UUID
openfinclaw strategy fork 34a5792f-7d20-4a15-90f3-26f1c54fa4a6

# 使用短 ID
openfinclaw strategy fork 34a5792f

# 使用 Hub URL
openfinclaw strategy fork https://hub.openfinclaw.ai/strategy/34a5792f-7d20-4a15-90f3-26f1c54fa4a6

# 指定日期
openfinclaw strategy fork 34a5792f --date 2026-03-01

# 自定义路径
openfinclaw strategy fork 34a5792f --dir ./my-strategies/
```

**输出示例:**

```
✓ 获取策略信息...
  名称: BTC Adaptive DCA
  作者: 黄吕靖
  市场: Crypto
  收益率: +243.0%
  夏普: 0.11

✓ 下载策略包...
✓ 解压到 ~/.openfinclaw/strategies/2026-03-16/btc-adaptive-dca-34a5792f/

策略已下载！
  编辑: code ~/.openfinclaw/strategies/2026-03-16/btc-adaptive-dca-34a5792f/scripts/strategy.py
  验证: openfinclaw strategy validate btc-adaptive-dca-34a5792f
  发布: openfinclaw strategy publish ~/.openfinclaw/strategies/2026-03-16/btc-adaptive-dca-34a5792f
```

### 4.3 `strategy create`

创建新的策略模板。

**用法:**

```bash
openfinclaw strategy create <name> [options]
```

**参数:**

- `<name>`: 策略名称（将作为目录名）

**选项:**

- `--dir <path>`: 自定义目标路径
- `--date <date>`: 指定日期目录
- `--template <type>`: 策略模板类型（basic, trend, mean-reversion）

**示例:**

```bash
openfinclaw strategy create my-btc-strategy
# 输出: ~/.openfinclaw/strategies/2026-03-16/my-btc-strategy/

openfinclaw strategy create eth-momentum --template trend
```

### 4.4 `strategy list`

列出本地所有策略。

**用法:**

```bash
openfinclaw strategy list [options]
```

**选项:**

- `--json`: JSON 格式输出
- `--date <date>`: 筛选特定日期
- `--all`: 包括已删除的（如有回收站机制）

**输出示例:**

```
2026-03-16/
  btc-adaptive-dca-34a5792f    BTC Adaptive DCA      Crypto    +243.0%    (forked)
  my-test-strategy              My Test Strategy      US        -          (created)

2026-03-15/
  eth-momentum-7e8a9b2c        ETH Momentum          Crypto    +12.5%     (forked)
```

### 4.5 `strategy show`

查看策略详情。

**用法:**

```bash
openfinclaw strategy show <name-or-id> [options]
```

**选项:**

- `--remote`: 从 Hub 获取最新信息
- `--json`: JSON 格式输出

### 4.6 `strategy validate`

验证策略包结构。

**用法:**

```bash
openfinclaw strategy validate <path>
```

### 4.7 `strategy remove`

删除本地策略。

**用法:**

```bash
openfinclaw strategy remove <name-or-id> [options]
```

**选项:**

- `--force, -f`: 强制删除，不确认

---

## 5. AI 工具设计

在 `extensions/openfinclaw/index.ts` 中新增以下工具：

### 5.1 `skill_fork`

从 Hub fork 策略到本地。

```typescript
{
  name: "skill_fork",
  label: "Fork strategy from Hub",
  description: "Download a public strategy from hub.openfinclaw.ai to local directory. The strategy will be extracted and ready for modification. Returns the local path.",
  parameters: Type.Object({
    strategyId: Type.String({
      description: "Strategy ID from Hub (UUID, short ID, or Hub URL)"
    }),
    targetDir: Type.Optional(Type.String({
      description: "Custom target directory. Default: ~/.openfinclaw/strategies/{date}/{name}-{shortId}/"
    })),
    dateDir: Type.Optional(Type.String({
      description: "Date directory (YYYY-MM-DD). Default: today"
    }))
  })
}
```

**返回示例:**

```json
{
  "success": true,
  "localPath": "~/.openfinclaw/strategies/2026-03-16/btc-adaptive-dca-34a5792f",
  "sourceId": "34a5792f-7d20-4a15-90f3-26f1c54fa4a6",
  "sourceName": "BTC Adaptive DCA",
  "sourceVersion": "1.0.0"
}
```

### 5.2 `skill_list_local`

列出本地策略。

```typescript
{
  name: "skill_list_local",
  label: "List local strategies",
  description: "List all strategies downloaded or created locally, organized by date.",
  parameters: Type.Object({})
}
```

### 5.3 `skill_get_info`

获取 Hub 策略详情。

```typescript
{
  name: "skill_get_info",
  label: "Get strategy info from Hub",
  description: "Fetch detailed information about a strategy from hub.openfinclaw.ai, including performance metrics.",
  parameters: Type.Object({
    strategyId: Type.String({
      description: "Strategy ID from Hub"
    })
  })
}
```

---

## 6. Hub API 端点设计

需要后端配合新增以下 API 端点：

### 6.1 获取策略详情

```
GET /api/v1/skill/{id}
```

**响应:**

```json
{
  "id": "34a5792f-7d20-4a15-90f3-26f1c54fa4a6",
  "name": "BTC Adaptive DCA",
  "slug": "btc-adaptive-dca",
  "version": "1.0.0",
  "author": {
    "name": "黄吕靖",
    "id": "user-xxx"
  },
  "description": "Adaptive DCA strategy for BTC",
  "tags": ["dca", "btc", "adaptive", "crypto"],
  "market": "Crypto",
  "visibility": "public",
  "performance": {
    "totalReturn": 2.43,
    "sharpe": 0.11,
    "maxDrawdown": -37.23,
    "winRate": 0.52,
    "totalTrades": 156
  },
  "createdAt": "2026-03-01T00:00:00Z",
  "updatedAt": "2026-03-15T00:00:00Z",
  "downloadCount": 42
}
```

### 6.2 下载策略包

```
GET /api/v1/skill/{id}/download
```

**响应:**

- Content-Type: `application/zip`
- Body: ZIP 文件内容

**ZIP 结构:**

```
strategy.zip
├── fep.yaml
└── scripts/
    └── strategy.py
```

### 6.3 搜索策略（可选）

```
GET /api/v1/skills?page=1&limit=20&market=crypto&sort=return&order=desc
```

**响应:**

```json
{
  "items": [
    { "id": "...", "name": "...", "performance": {...} }
  ],
  "total": 100,
  "page": 1,
  "limit": 20
}
```

---

## 7. 代码模块结构

```
extensions/openfinclaw/
├── index.ts                    # 主入口，注册工具和 CLI
├── package.json
├── src/
│   ├── validate.ts             # 现有：本地验证
│   ├── fork.ts                 # 新增：fork 核心逻辑
│   ├── strategy-storage.ts     # 新增：本地存储管理
│   ├── types.ts                # 新增：类型定义
│   └── cli/
│       └── strategy-command.ts # 新增：CLI 命令实现
└── skills/
    ├── strategy-pack/
    ├── skill-publish/
    ├── fin-strategy-builder/
    └── strategy-fork/          # 新增：fork skill 文档
        └── SKILL.md
```

### 7.1 核心模块职责

| 模块                      | 职责                                     |
| ------------------------- | ---------------------------------------- |
| `fork.ts`                 | 策略下载、解压、元数据生成               |
| `strategy-storage.ts`     | 本地目录管理、策略索引、路径解析         |
| `types.ts`                | 类型定义（ForkResult, LocalStrategy 等） |
| `cli/strategy-command.ts` | CLI 命令实现（fork, list, create 等）    |

### 7.2 核心函数签名

```typescript
// src/fork.ts

interface ForkOptions {
  targetDir?: string;
  dateDir?: string;
}

interface ForkResult {
  success: boolean;
  localPath: string;
  sourceId: string;
  sourceShortId: string;
  sourceName: string;
  sourceVersion: string;
  error?: string;
}

/**
 * 从 Hub 下载并解压策略到本地
 */
export async function forkStrategy(
  config: SkillApiConfig,
  strategyId: string,
  options?: ForkOptions,
): Promise<ForkResult>;

/**
 * 解析策略 ID（支持 UUID、短 ID、URL）
 */
export function parseStrategyId(input: string): string;

/**
 * 生成 slugified 目录名
 */
export function slugifyName(name: string): string;
```

```typescript
// src/strategy-storage.ts

interface LocalStrategy {
  name: string;
  displayName: string;
  localPath: string;
  dateDir: string;
  type: "forked" | "created";
  sourceId?: string;
  createdAt: string;
  performance?: StrategyPerformance;
}

interface StrategyPerformance {
  totalReturn?: number;
  sharpe?: number;
  maxDrawdown?: number;
  winRate?: number;
}

/**
 * 获取策略存储根目录
 */
export function getStrategiesRoot(): string;

/**
 * 列出所有本地策略
 */
export async function listLocalStrategies(): Promise<LocalStrategy[]>;

/**
 * 按名称或短 ID 查找本地策略
 */
export async function findLocalStrategy(nameOrId: string): Promise<LocalStrategy | null>;

/**
 * 删除本地策略
 */
export async function removeLocalStrategy(nameOrId: string): Promise<void>;

/**
 * 创建日期目录
 */
export function createDateDir(baseDir: string, date?: string): string;
```

---

## 8. 易用性设计

### 8.1 智能 ID 解析

支持多种输入格式：

- 完整 UUID: `34a5792f-7d20-4a15-90f3-26f1c54fa4a6`
- 短 ID: `34a5792f`（自动补全，若有歧义则提示选择）
- Hub URL: `https://hub.openfinclaw.ai/strategy/34a5792f-7d20-4a15-90f3-26f1c54fa4a6`

### 8.2 下载前预览

在下载前显示策略基本信息，让用户确认：

```
策略信息:
  名称: BTC Adaptive DCA
  作者: 黄吕靖
  市场: Crypto
  收益率: +243.0%
  夏普: 0.11
  最大回撤: -3723.0%

是否下载？ [Y/n]
```

使用 `--yes` 跳过确认。

### 8.3 冲突处理

如果目标目录已存在：

```
✗ 目录已存在: ~/.openfinclaw/strategies/2026-03-16/btc-adaptive-dca-34a5792f/

选项:
  [O] 覆盖现有目录
  [R] 重命名 (btc-adaptive-dca-34a5792f-20260316-101530)
  [C] 取消

请选择:
```

### 8.4 离线支持

- `.fork-meta.json` 缓存策略元数据
- 无网络时可查看本地策略信息
- `list` 和 `show` 命令优先读取本地缓存

---

## 9. 典型使用流程

### 9.1 用户视角

```
1. 在 Hub 网页浏览策略 → 点击策略详情 → 复制策略 ID
2. 运行: openfinclaw strategy fork 34a5792f-7d20-4a15-90f3-26f1c54fa4a6
3. 查看下载位置，编辑 scripts/strategy.py
4. 验证修改: openfinclaw strategy validate ~/.openfinclaw/strategies/2026-03-16/btc-adaptive-dca-34a5792f
5. 发布新版本: openfinclaw strategy publish ...
```

### 9.2 AI Agent 视角

```
用户: "帮我下载那个收益 453% 的 BTC 策略"

Agent:
1. 调用 skill_get_info 或搜索 Hub 找到策略 ID
2. 调用 skill_fork 下载策略
3. 调用 skill_validate 验证策略包
4. 返回本地路径给用户

用户: "帮我把止损参数改成 5%"

Agent:
1. 读取 scripts/strategy.py
2. 修改止损参数
3. 调用 skill_validate 验证
4. 建议用户发布新版本
```

---

## 10. 后续扩展

### 10.1 版本更新检测

```bash
openfinclaw strategy check-update <name-or-id>
# 检查 fork 来源策略是否有新版本
```

### 10.2 策略对比

```bash
openfinclaw strategy diff <local> <remote-id>
# 对比本地修改与原策略差异
```

### 10.3 批量操作

```bash
openfinclaw strategy fork --file strategies.txt
# 批量下载多个策略
```

---

## 11. 实施计划

| 阶段 | 内容                                            | 优先级 |
| ---- | ----------------------------------------------- | ------ |
| P0   | CLI `strategy fork` 命令 + AI 工具 `skill_fork` | 高     |
| P0   | 本地存储管理模块                                | 高     |
| P1   | CLI `strategy list` / `show` / `remove` 命令    | 中     |
| P1   | AI 工具 `skill_list_local` / `skill_get_info`   | 中     |
| P2   | CLI `strategy create` 命令                      | 低     |
| P2   | 版本更新检测                                    | 低     |

---

## 12. 相关文档

- [FEP v1.2 规范](./fep-v1.2-reference.yaml)
- [策略构建工具配置](./strategy-builder-tools-config.md)
- [回测配置](./conversation-strategy-backtest-config.md)
