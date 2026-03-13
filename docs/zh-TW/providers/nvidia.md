---
summary: Use NVIDIA's OpenAI-compatible API in OpenClaw
read_when:
  - You want to use NVIDIA models in OpenClaw
  - You need NVIDIA_API_KEY setup
title: NVIDIA
---

# NVIDIA

NVIDIA 提供與 OpenAI 相容的 API，位於 `https://integrate.api.nvidia.com/v1`，適用於 Nemotron 和 NeMo 模型。請使用來自 [NVIDIA NGC](https://catalog.ngc.nvidia.com/) 的 API 金鑰進行驗證。

## CLI 設定

匯出金鑰一次，接著執行 onboarding 並設定 NVIDIA 模型：

```bash
export NVIDIA_API_KEY="nvapi-..."
openclaw onboard --auth-choice skip
openclaw models set nvidia/nvidia/llama-3.1-nemotron-70b-instruct
```

如果你仍然傳遞 `--token`，請記得它會被記錄在 shell 歷史紀錄和 `ps` 輸出中；建議盡可能使用環境變數。

## 設定片段

```json5
{
  env: { NVIDIA_API_KEY: "nvapi-..." },
  models: {
    providers: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "nvidia/nvidia/llama-3.1-nemotron-70b-instruct" },
    },
  },
}
```

## 模型 ID

- `nvidia/llama-3.1-nemotron-70b-instruct`（預設）
- `meta/llama-3.3-70b-instruct`
- `nvidia/mistral-nemo-minitron-8b-8k-instruct`

## 注意事項

- OpenAI 相容的 `/v1` 端點；請使用 NVIDIA NGC 的 API 金鑰。
- 當設定 `NVIDIA_API_KEY` 時，提供者會自動啟用；使用靜態預設值（131,072 token 的上下文視窗，最大 4,096 token）。
