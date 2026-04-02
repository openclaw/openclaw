# Bridge Seismic Analysis

抗震分析 Skill，按照 JTG/T B02-01-2008《公路桥梁抗震设计细则》进行抗震性能评估。

## Overview

本 Skill 提供桥梁抗震分析和验算功能，包括：
- 结构周期计算
- 设计加速度反应谱计算
- 水平地震力计算
- 位移验算
- E1/E2 地震作用验算

## Usage

```
bridge-seismic-analysis span:<span> pierHeight:<height> seismicIntensity:<intensity>
```

### Parameters

- `span`: 跨径（米）
- `pierHeight`: 墩高（米）
- `seismicIntensity`: 地震烈度 (`VI`, `VII`, `VIII`, `IX`)
- `siteClass`: 场地类别 (`I`, `II`, `III`, `IV`)

### Examples

```
# 8度区抗震分析
bridge-seismic-analysis span:30 pierHeight:8 seismicIntensity:VIII

# 7度区抗震分析
bridge-seismic-analysis span:40 pierHeight:10 seismicIntensity:VII siteClass:II
```

## Actions

| Action | Description |
|--------|-------------|
| `analyze` | 执行抗震分析 |

## Reference

- JTG/T B02-01-2008 公路桥梁抗震设计细则
