# Bridge Quantity Survey

工程量计算 Skill，根据设计参数自动统计桥梁各部分工程量。

## Overview

本 Skill 提供桥梁工程量的自动统计功能，包括：
- 上部结构工程量（主梁、桥面板、湿接缝）
- 下部结构工程量（桥墩、桥台）
- 基础工程量（桩基础、承台）
- 附属工程量（铺装、护栏、伸缩缝、支座）
- 材料估算和造价估算

## Usage

```
bridge-quantity-survey bridgeType:<type> span:<span> width:<width>
```

### Parameters

- `bridgeType`: 桥梁类型 (`girder`, `box`, `arch`)
- `span`: 跨径（米）
- `width`: 桥面宽度（米）
- `spanCount`: 跨数

### Examples

```
# 计算简支梁桥工程量
bridge-quantity-survey bridgeType:girder span:30 width:12 spanCount:1

# 计算连续梁桥工程量
bridge-quantity-survey bridgeType:box span:40 width:12 spanCount:3
```

## Actions

| Action | Description |
|--------|-------------|
| `calculate` | 执行工程量计算 |

## Reference

- JTG/T 3832-2018 公路工程预算定额
