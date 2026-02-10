# CodexBar CLI quick ref (usage + cost)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- App: Preferences -> Advanced -> Install CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repo: ./bin/install-codexbar-cli.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Usage snapshot (web/cli sources):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - codexbar usage --format json --pretty（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - codexbar --provider all --format json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local cost usage (Codex + Claude only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - codexbar cost --format json --pretty（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - codexbar cost --provider codex|claude --format json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost JSON fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The payload is an array (one per provider).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- provider, source, updatedAt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- sessionTokens, sessionCostUSD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- last30DaysTokens, last30DaysCostUSD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- daily[]: date, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens, totalCost, modelsUsed, modelBreakdowns[]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- modelBreakdowns[]: modelName, cost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- totals: totalInputTokens, totalOutputTokens, cacheReadTokens, cacheCreationTokens, totalTokens, totalCost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cost usage is local-only. It reads JSONL logs under:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Codex: ~/.codex/sessions/\*_/_.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Claude: ~/.config/claude/projects/**/\*.jsonl or ~/.claude/projects/**/\*.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If web usage is required (non-local), use codexbar usage (not cost).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
