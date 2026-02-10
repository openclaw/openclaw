---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: model-usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Use CodexBar CLI local cost usage to summarize per-model usage for Codex or Claude, including the current (most recent) model or a full model breakdown. Trigger when asked for model-level usage/cost data from codexbar, or when you need a scriptable per-model summary from codexbar cost JSON.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📊",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "os": ["darwin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["codexbar"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew-cask",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "cask": "steipete/tap/codexbar",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["codexbar"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install CodexBar (brew cask)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Model usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Get per-model usage cost from CodexBar's local cost logs. Supports "current model" (most recent daily entry) or "all models" summaries for Codex or Claude.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
TODO: add Linux CLI support guidance once CodexBar CLI install path is documented for Linux.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Fetch cost JSON via CodexBar CLI or pass a JSON file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Use the bundled script to summarize by model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python {baseDir}/scripts/model_usage.py --provider codex --mode current（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python {baseDir}/scripts/model_usage.py --provider codex --mode all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python {baseDir}/scripts/model_usage.py --provider claude --mode all --format json --pretty（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Current model logic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses the most recent daily row with `modelBreakdowns`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Picks the model with the highest cost in that row.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Falls back to the last entry in `modelsUsed` when breakdowns are missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Override with `--model <name>` when you need a specific model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: runs `codexbar cost --format json --provider <codex|claude>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- File or stdin:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
codexbar cost --provider codex --format json > /tmp/cost.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
python {baseDir}/scripts/model_usage.py --input /tmp/cost.json --mode all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat /tmp/cost.json | python {baseDir}/scripts/model_usage.py --input - --mode current（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Text (default) or JSON (`--format json --pretty`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Values are cost-only per model; tokens are not split by model in CodexBar output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## References（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read `references/codexbar-cli.md` for CLI flags and cost JSON fields.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
