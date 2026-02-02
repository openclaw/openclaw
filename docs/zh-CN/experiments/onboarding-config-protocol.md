---
read_when: 修改新手引导向导步骤或配置 schema 端点时
summary: 新手引导向导和配置 schema 的 RPC 协议说明
title: 新手引导与配置协议
x-i18n:
  generated_at: "2026-02-01T20:24:58Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 55163b3ee029c02476800cb616a054e5adfe97dae5bb72f2763dce0079851e06
  source_path: experiments/onboarding-config-protocol.md
  workflow: 14
---

# 新手引导 + 配置协议

用途：在 CLI、macOS 应用和 Web UI 之间共享新手引导与配置界面。

## 组件

- 向导引擎（共享会话 + 提示 + 新手引导状态）。
- CLI 新手引导使用与 UI 客户端相同的向导流程。
- Gateway网关 RPC 暴露向导 + 配置 schema 端点。
- macOS 新手引导使用向导步骤模型。
- Web UI 根据 JSON Schema + UI 提示渲染配置表单。

## Gateway网关 RPC

- `wizard.start` 参数：`{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` 参数：`{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` 参数：`{ sessionId }`
- `wizard.status` 参数：`{ sessionId }`
- `config.schema` 参数：`{}`

响应（结构）

- 向导：`{ sessionId, done, step?, status?, error? }`
- 配置 schema：`{ schema, uiHints, version, generatedAt }`

## UI 提示

- `uiHints` 按路径作为键；可选元数据（label/help/group/order/advanced/sensitive/placeholder）。
- 敏感字段渲染为密码输入框；无脱敏层。
- 不支持的 schema 节点回退到原始 JSON 编辑器。

## 说明

- 本文档是跟踪新手引导/配置协议重构的唯一位置。
