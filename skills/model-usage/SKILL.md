---
name: model-usage
description: Summarize CodexBar local cost logs by model for Codex or Claude, including current or full breakdowns.
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "os": ["darwin"],
        "requires": { "bins": ["codexbar"] },
        "install":
          [
            {
              "id": "brew-cask",
              "kind": "brew",
              "formula": "steipete/tap/codexbar",
              "bins": ["codexbar"],
              "label": "Install CodexBar (brew cask)",
            },
          ],
      },
  }
---

# Model usage

## 概述

从 CodexBar 的本地成本日志获取每个模型的 usage 成本。支持 Codex 或 Claude 的"当前模型"（最近的每日条目）或"所有模型"摘要。

TODO：一旦 CodexBar CLI 安装路径为 Linux 记录了，将添加 Linux CLI 支持指导。

## 快速开始

1. 通过 CodexBar CLI 获取成本 JSON 或传递 JSON 文件。
2. 使用捆绑脚本按模型汇总。

```bash
python {baseDir}/scripts/model_usage.py --provider codex --mode current
python {baseDir}/scripts/model_usage.py --provider codex --mode all
python {baseDir}/scripts/model_usage.py --provider claude --mode all --format json --pretty
```

## 当前模型逻辑

- 使用具有 `modelBreakdowns` 的最新每日行。
- 选择该行中成本最高的模型。
- 当缺少 breakdown 时回退到 `modelsUsed` 中的最后一个条目。
- 当您需要特定模型时使用 `--model <name>` 覆盖。

## 输入

- 默认：运行 `codexbar cost --format json --provider <codex|claude>`。
- 文件或 stdin：

```bash
codexbar cost --provider codex --format json > /tmp/cost.json
python {baseDir}/scripts/model_usage.py --input /tmp/cost.json --mode all
cat /tmp/cost.json | python {baseDir}/scripts/model_usage.py --input - --mode current
```

## 输出

- 文本（默认）或 JSON（`--format json --pretty`）。
- 值仅为每个模型的 cost；令牌在 CodexBar 输出中不按模型分割。

## 参考资料

- 阅读 `references/codexbar-cli.md` 了解 CLI 标志和成本 JSON 字段。
