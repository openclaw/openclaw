---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use OpenCode Zen (curated models) with OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want OpenCode Zen for model access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a curated list of coding-friendly models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "OpenCode Zen"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenCode Zen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenCode Zen is a **curated list of models** recommended by the OpenCode team for coding agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It is an optional, hosted model access path that uses an API key and the `opencode` provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Zen is currently in beta.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice opencode-zen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# or non-interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config snippet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { OPENCODE_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCODE_ZEN_API_KEY` is also supported.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You sign in to Zen, add billing details, and copy your API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenCode Zen bills per request; check the OpenCode dashboard for details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
