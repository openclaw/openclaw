---
summary: OpenClaw Secrets 管理（SecretRef、激活流程、审计与应用）
title: Secrets 管理
sidebarTitle: Secrets
---

# Secrets 管理

该页面是英文文档的中文占位版本，完整内容请先参考英文版：[Secrets Management](/gateway/secrets)。

## 中文速览

OpenClaw 支持通过 **SecretRef** 引用外部凭据，避免将 API Key/Token 明文写入配置文件。

核心要点：

- 凭据会在激活阶段解析到内存快照（不是在请求路径上临时拉取）。
- 启动时解析失败会 fail-fast；运行中重载失败会保留 last-known-good。
- 支持 `env` / `file` / `exec` 三类 provider。
- 当同一字段同时存在明文和 ref 时，运行时以 ref 为准。

## 推荐操作顺序

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

如需字段契约、provider 配置、故障场景与运维细节，请阅读英文原文。
