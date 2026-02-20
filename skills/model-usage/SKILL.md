---
name: model-usage
description: Summarize model-level cost usage and basic observability for OpenClaw. Use when you need CodexBar per-model cost (current/all), recent failed or aborted sessions, or a combined overview report for cost + errors.
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "os": ["darwin", "linux"],
        "requires": { "bins": ["codexbar", "openclaw"] },
      },
  }
---

# Model usage + observability

## Overview

统一脚本，支持两类能力：

1. 成本：基于 CodexBar 的 per-model cost 汇总
2. 可观测：基于 OpenClaw sessions 的失败会话扫描 + 网关日志提示

## Usage

```bash
# 成本：当前模型
python {baseDir}/scripts/model_usage.py --provider codex --mode current

# 成本：全部模型
python {baseDir}/scripts/model_usage.py --provider codex --mode all --days 7

# 错误观测：最近失败/中止会话
python {baseDir}/scripts/model_usage.py --mode errors --error-limit 50

# 总览：成本 + 错误
python {baseDir}/scripts/model_usage.py --provider codex --mode overview --days 7 --error-limit 50

# JSON 输出
python {baseDir}/scripts/model_usage.py --mode overview --format json --pretty
```

## Modes

- `current`: 当前模型成本摘要
- `all`: 全模型成本汇总
- `errors`: 最近失败/中止会话 + 日志提示
- `overview`: 成本与错误合并输出

## Notes

- `current/all/overview` 需要 `codexbar`。
- `errors/overview` 需要 `openclaw`。
- 日志读取优先 `journalctl`（Linux/systemd）；在 macOS 会尝试 `~/.openclaw/logs/gateway.log`。

## References

- `references/codexbar-cli.md`
