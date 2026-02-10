---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use OpenAI via API keys or Codex subscription in OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use OpenAI models in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want Codex subscription auth instead of API keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "OpenAI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenAI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenAI provides developer APIs for GPT models. Codex supports **ChatGPT sign-in** for subscription（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
access or **API key** sign-in for usage-based access. Codex cloud requires ChatGPT sign-in.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Option A: OpenAI API key (OpenAI Platform)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Best for:** direct API access and usage-based billing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Get your API key from the OpenAI dashboard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### CLI setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice openai-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# or non-interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --openai-api-key "$OPENAI_API_KEY"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config snippet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { OPENAI_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Option B: OpenAI Code (Codex) subscription（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Best for:** using ChatGPT/Codex subscription access instead of an API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Codex cloud requires ChatGPT sign-in, while the Codex CLI supports ChatGPT or API key sign-in.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### CLI setup (Codex OAuth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Run Codex OAuth in the wizard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice openai-codex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or run OAuth directly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth login --provider openai-codex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config snippet (Codex subscription)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model refs always use `provider/model` (see [/concepts/models](/concepts/models)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
