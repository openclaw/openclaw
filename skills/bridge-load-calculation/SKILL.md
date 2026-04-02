# Bridge Load Calculation

桥梁荷载计算 Skill，根据 GB/T 50283-2022《公路桥梁设计通用规范》进行各类荷载计算。

## Overview

本 Skill 提供桥梁工程中的荷载自动计算功能，包括：
- 恒载（结构自重、桥面铺装、护栏等）
- 汽车荷载（公路-I级、公路-II级）
- 风荷载
- 地震荷载

## Usage

```
bridge-load-calculation type:<load_type> span:<span_length> width:<width>
```

### Parameters

- `type`: 荷载类型 (`dead`, `live`, `wind`, `seismic`, `all`)
- `span`: 跨径长度（米）
- `width`: 桥面宽度（米）
- `trafficGrade`: 公路等级 (`highway-I`, `highway-II`)
- `material`: 材料类型 (`concrete`, `steel`)

### Examples

```
# 计算恒载
bridge-load-calculation type:dead span:30 width:12

# 计算公路-I级汽车荷载
bridge-load-calculation type:live span:30 width:12 trafficGrade:highway-I

# 计算全部荷载
bridge-load-calculation type:all span:30 width:12
```

## Actions

| Action | Description |
|--------|-------------|
| `calculate` | 执行荷载计算 |

## Reference

- GB/T 50283-2022 公路桥梁设计通用规范
