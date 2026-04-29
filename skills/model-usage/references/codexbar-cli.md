# CodexBar CLI 快速参考（usage + cost）

## 安装

- 应用：偏好设置 -> 高级 -> 安装 CLI
- 仓库：./bin/install-codexbar-cli.sh

## 命令

- Usage 快照（web/cli 来源）：
  - codexbar usage --format json --pretty
  - codexbar --provider all --format json
- 本地成本 usage（仅 Codex + Claude）：
  - codexbar cost --format json --pretty
  - codexbar cost --provider codex|claude --format json

## 成本 JSON 字段

payload 是一个数组（每个提供商一个）。

- provider、source、updatedAt
- sessionTokens、sessionCostUSD
- last30DaysTokens、last30DaysCostUSD
- daily[]：date、inputTokens、outputTokens、cacheReadTokens、cacheCreationTokens、totalTokens、totalCost、modelsUsed、modelBreakdowns[]
- modelBreakdowns[]：modelName、cost
- totals：totalInputTokens、totalOutputTokens、cacheReadTokens、cacheCreationTokens、totalTokens、totalCost

## 提示

- 成本 usage 是本地-only。它读取以下位置的 JSONL 日志：
  - Codex: ~/.codex/sessions/\*_/_.jsonl
  - Claude: ~/.config/claude/projects/\*\*/\*.jsonl 或 ~/.claude/projects/\*\*/\*.jsonl
- 如果需要 Web usage（非本地），使用 codexbar usage（不是 cost）。
