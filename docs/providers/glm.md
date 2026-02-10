---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "GLM model family overview + how to use it in OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want GLM models in OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need the model naming convention and setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "GLM Models"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# GLM models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
GLM is a **model family** (not a company) available through the Z.AI platform. In OpenClaw, GLM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
models are accessed via the `zai` provider and model IDs like `zai/glm-4.7`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard --auth-choice zai-api-key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
- GLM versions and availability can change; check Z.AI's docs for the latest.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example model IDs include `glm-4.7` and `glm-4.6`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For provider details, see [/providers/zai](/providers/zai).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
