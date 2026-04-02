# Bridge Structure Check

桥梁结构验算 Skill，按照 JTG 3362-2018《公路钢筋混凝土及预应力混凝土桥涵设计规范》进行结构安全性验算。

## Overview

本 Skill 提供桥梁结构的安全验算功能，包括：
- 正截面受弯承载力验算
- 斜截面受剪承载力验算
- 刚度验算（挠度）
- 稳定性验算

## Usage

```
bridge-structure-check type:<check_type> span:<span_length> width:<width> height:<height>
```

### Parameters

- `type`: 验算类型 (`strength`, `stiffness`, `stability`, `all`)
- `span`: 跨径长度（米）
- `width`: 截面宽度（mm）
- `height`: 截面高度（mm）
- `fc`: 混凝土抗压强度（MPa）
- `fy`: 钢筋抗拉强度（MPa）

### Examples

```
# 强度验算
bridge-structure-check type:strength span:30 width:2000 height:1500

# 刚度验算
bridge-structure-check type:stiffness span:30 width:2000 height:1500

# 全部验算
bridge-structure-check type:all span:30 width:2000 height:1500
```

## Actions

| Action | Description |
|--------|-------------|
| `check` | 执行结构验算 |

## Reference

- JTG 3362-2018 公路钢筋混凝土及预应力混凝土桥涵设计规范
