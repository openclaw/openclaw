# Bridge Foundation Design

基础设计 Skill，进行桥梁基础的设计计算和承载力验算。

## Overview

本 Skill 提供桥梁基础的设计计算功能，包括：
- 桩基础竖向承载力计算
- 桩基础水平承载力计算
- 扩大基础承载力验算
- 沉井基础下沉系数计算

## Usage

```
bridge-foundation-design type:<foundation_type> load:<load>
```

### Parameters

- `type`: 基础类型 (`pile`, `spread`, `caisson`)
- `load`: 竖向荷载（kN）
- `momentX`: X向弯矩（kN·m）
- `momentY`: Y向弯矩（kN·m）
- `horizontalLoad`: 水平荷载（kN）

### Examples

```
# 桩基础设计
bridge-foundation-design type:pile load:5000 momentX:200

# 扩大基础设计
bridge-foundation-design type:spread load:5000 momentX:200

# 沉井基础设计
bridge-foundation-design type:caisson load:10000
```

## Actions

| Action | Description |
|--------|-------------|
| `design` | 执行基础设计计算 |

## Reference

- JTG 3363-2019 公路桥涵地基与基础设计规范
