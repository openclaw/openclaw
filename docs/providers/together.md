---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Together AI setup (auth + model selection)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use Together AI with OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need the API key env var or CLI auth choice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Together AI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The [Together AI](https://together.ai) provides access to leading open-source models including Llama, DeepSeek, Kimi, and more through a unified API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider: `together`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: `TOGETHER_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- API: OpenAI-compatible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Set the API key (recommended: store it for the Gateway):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice together-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Set a default model:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "together/zai-org/GLM-4.7" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Non-interactive example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --non-interactive \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --mode local \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --auth-choice together-api-key \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --together-api-key "$TOGETHER_API_KEY"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This will set `together/zai-org/GLM-4.7` as the default model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Environment note（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs as a daemon (launchd/systemd), make sure `TOGETHER_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is available to that process (for example, in `~/.clawdbot/.env` or via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`env.shellEnv`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Available models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Together AI provides access to many popular open-source models:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **GLM 4.7 Fp8** - Default model with 200K context window（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Llama 3.3 70B Instruct Turbo** - Fast, efficient instruction following（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Llama 4 Scout** - Vision model with image understanding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Llama 4 Maverick** - Advanced vision and reasoning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **DeepSeek V3.1** - Powerful coding and reasoning model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **DeepSeek R1** - Advanced reasoning model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Kimi K2 Instruct** - High-performance model with 262K context window（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All models support standard chat completions and are OpenAI API compatible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
