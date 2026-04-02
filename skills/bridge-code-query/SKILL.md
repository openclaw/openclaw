# Bridge Code Query

桥梁规范查询 Skill，快速检索 JTG 系列桥梁规范条文。

## Overview

本 Skill 提供桥梁工程相关规范的快速检索功能，支持：
- GB/T 50283-2022 公路桥梁设计通用规范
- JTG 3362-2018 公路钢筋混凝土及预应力混凝土桥涵设计规范
- JTG/T B02-01-2008 公路桥梁抗震设计细则
- JTG 3363-2019 公路桥涵地基与基础设计规范

## Usage

```
bridge-code-query code:<code_name> article:<article_number>
```

### Parameters

- `code`: 规范名称（可选）
- `article`: 条文号（可选）
- `query`: 查询关键词（可选）

### Examples

```
# 查询车辆荷载条文
bridge-code-query query:车辆荷载

# 查询指定规范条文
bridge-code-query code:GB/T 50283 article:4.3

# 列出所有规范
bridge-code-query
```

## Actions

| Action | Description |
|--------|-------------|
| `query` | 查询规范条文 |

## Reference

- JTG 系列桥梁规范
