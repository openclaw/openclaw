# Strategy Fork Skill

从 Hub 下载公开策略到本地，支持二次开发和优化。

## 概述

本 skill 提供从 hub.openfinclaw.ai 下载策略的功能，使用户能够：

- 浏览并下载公开策略到本地
- 基于现有策略进行修改和优化
- 发布自己的改进版本

## 工具列表

| 工具               | 用途                  |
| ------------------ | --------------------- |
| `skill_fork`       | 从 Hub 下载策略到本地 |
| `skill_list_local` | 列出本地已下载的策略  |
| `skill_get_info`   | 获取 Hub 策略详情     |

## 目录结构

```
~/.openfinclaw/workspace/strategies/
└── 2026-03-16/                              # 按日期组织
    ├── btc-adaptive-dca-34a5792f/           # 名称 + 短ID（防冲突）
    │   ├── fep.yaml                         # 策略配置
    │   ├── scripts/
    │   │   └── strategy.py                  # 策略代码
    │   └── .fork-meta.json                  # 元数据
    └── my-new-strategy/                     # 自建策略（无短ID）
        └── ...
```

## 使用方式

### 1. 查看策略信息

在 fork 之前，可以先获取策略详情：

```
调用 skill_get_info 并传入策略 ID
```

示例参数：

```json
{
  "strategyId": "34a5792f-7d20-4a15-90f3-26f1c54fa4a6"
}
```

也支持 Hub URL：

- URL: `https://hub.openfinclaw.ai/strategy/34a5792f-7d20-4a15-90f3-26f1c54fa4a6`

### 2. Fork 策略

下载策略到本地：

```
调用 skill_fork 并传入策略 ID
```

示例参数：

```json
{
  "strategyId": "34a5792f-7d20-4a15-90f3-26f1c54fa4a6"
}
```

可选参数：

- `targetDir`: 自定义目标目录
- `dateDir`: 指定日期目录（YYYY-MM-DD）

### 3. 列出本地策略

查看已下载的策略：

```
调用 skill_list_local
```

### 4. 编辑和发布

fork 后的完整流程：

1. 编辑 `scripts/strategy.py` 修改策略逻辑
2. 调用 `skill_validate` 验证策略包
3. 调用 `skill_publish` 发布新版本

## CLI 命令

用户也可以通过命令行操作：

```bash
# Fork 策略
openfinclaw strategy fork 34a5792f-7d20-4a15-90f3-26f1c54fa4a6

# 列出本地策略
openfinclaw strategy list

# 查看详情
openfinclaw strategy show btc-adaptive-dca-34a5792f --remote

# 删除策略
openfinclaw strategy remove btc-adaptive-dca-34a5792f --force
```

## 典型场景

### 场景 1：学习优秀策略

用户: "帮我下载那个收益 453% 的 BTC 策略"

Agent:

1. 搜索 Hub 或访问 leaderboard 找到策略 ID
2. 调用 `skill_get_info` 展示策略信息
3. 用户确认后调用 `skill_fork` 下载
4. 返回本地路径供用户研究

### 场景 2：基于现有策略优化

用户: "我想在 BTC DCA 策略基础上增加止损功能"

Agent:

1. 调用 `skill_fork` 下载原策略
2. 读取 `scripts/strategy.py` 分析逻辑
3. 添加止损参数和逻辑
4. 调用 `skill_validate` 验证
5. 建议用户发布新版本

### 场景 3：管理本地策略

用户: "我之前下载了哪些策略？"

Agent:

1. 调用 `skill_list_local` 列出所有本地策略
2. 按日期分组展示
3. 可进一步调用 `skill_get_info` 获取特定策略的最新信息

## 注意事项

1. **API Key**: 某些操作需要配置 API Key

   ```bash
   openfinclaw config set plugins.entries.openfinclaw.config.skillApiKey YOUR_KEY
   ```

2. **同名冲突**: 如果两个策略名称相同，会自动添加短 ID 后缀区分

3. **目录已存在**: 如果目标目录已存在，fork 会失败并提示路径冲突

4. **网络要求**: 需要能够访问 hub.openfinclaw.ai

## 相关文档

- [策略 Fork 模块设计文档](/finance/strategy-fork-module-design)
- [FEP v2.0 协议说明](/finance/FEP-v2.0-协议说明)
- [策略发布指南](/skills/skill-publish/SKILL.md)
