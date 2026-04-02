# Bridge Drawing Review

图纸审查 Skill，自动检查桥梁施工图纸的标注规范性、完整性和与规范的一致性。

## Overview

本 Skill 提供桥梁施工图纸的自动审查功能，包括：
- 尺寸标注完整性和规范性检查
- 钢筋标注检查（编号、规格、根数、间距）
- 文字标注检查（字体、重叠、必要说明）
- 图纸比例检查
- 标题栏信息检查

## Usage

```
bridge-drawing-review drawingType:<type>
```

### Parameters

- `drawingType`: 图纸类型 (`general`, `rebar`, `prestress`, `foundation`)
- `checkItems`: 检查项目列表

### Examples

```
# 审查钢筋图
bridge-drawing-review drawingType:rebar

# 审查总体布置图
bridge-drawing-review drawingType:general
```

## Actions

| Action | Description |
|--------|-------------|
| `review` | 执行图纸审查 |

## Reference

- JTG/T 3650-2020 公路桥涵施工技术规范
