---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Use Z.AI (GLM models) with OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want Z.AI / GLM models in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a simple ZAI_API_KEY setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Z.AI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Z.AI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Z.AI is the API platform for **GLM** models. It provides REST APIs for GLM and uses API keys（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for authentication. Create your API key in the Z.AI console. OpenClaw uses the `zai` provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
with a Z.AI API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice zai-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# or non-interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --zai-api-key "$ZAI_API_KEY"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config snippet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { ZAI_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- GLM models are available as `zai/<model>` (example: `zai/glm-4.7`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [/providers/glm](/providers/glm) for the model family overview.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Z.AI uses Bearer auth with your API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
