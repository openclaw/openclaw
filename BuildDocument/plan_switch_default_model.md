# 默认切换模型计划

## 任务背景

用户要求将默认模型切换到 `gpt-5.4`。

## 操作步骤

1. 修改配置文件 `/Users/ppg/.openclaw/openclaw.json`。
2. 更新 `agents.defaults.model.primary` 为 `openai/gpt-5.4`。
3. 更新 `agents.list[0].model.primary` 为 `openai/gpt-5.4`（如果适用）。
4. 验证配置文件的 JSON 格式是否正确。

## 预期结果

OpenClaw 在处理请求时将默认使用 `gpt-5.4` 模型。
