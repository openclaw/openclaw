---
summary: "`openclaw docs`的CLI参考（搜索实时文档索引）"
read_when:
  - 您想从终端搜索实时OpenClaw文档
title: "docs"
---

# `openclaw docs`

搜索实时文档索引。

参数：

- `[query...]`: 发送到实时文档索引的搜索词

示例：

```bash
openclaw docs
openclaw docs browser existing-session
openclaw docs sandbox allowHostControl
openclaw docs gateway token secretref
```

注意事项：

- 没有查询时，`openclaw docs`打开实时文档搜索入口点。
- 多词查询作为一个搜索请求传递。