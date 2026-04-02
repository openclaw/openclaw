# Bridge Prestress Calculation

预应力计算 Skill，进行预应力混凝土桥梁的预应力损失计算和应力验算。

## Overview

本 Skill 提供预应力混凝土桥梁的计算功能，包括：
- 预应力损失计算（7项损失）
- 有效预应力计算
- 使用阶段应力验算
- 钢绞线用量估算

## Usage

```
bridge-prestress-calc span:<span> tendonType:<type> initialTension:<tension>
```

### Parameters

- `span`: 跨径（米）
- `tendonType`: 钢束类型 (`15.2`, `15.7`)
- `initialTension`: 张拉控制应力（MPa）
- `tendonArea`: 钢束面积（m²）

### Examples

```
# 标准预应力计算
bridge-prestress-calc span:30 tendonType:15.2 initialTension:1395

# 大跨度预应力计算
bridge-prestress-calc span:50 tendonType:15.7 initialTension:1395
```

## Actions

| Action | Description |
|--------|-------------|
| `calculate` | 执行预应力计算 |

## Reference

- JTG 3362-2018 公路钢筋混凝土及预应力混凝土桥涵设计规范
