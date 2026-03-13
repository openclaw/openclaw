---
summary: Hugging Face Inference setup (auth + model selection)
read_when:
  - You want to use Hugging Face Inference with OpenClaw
  - You need the HF token env var or CLI auth choice
title: Hugging Face (Inference)
---

# Hugging Face（推論）

[Hugging Face 推論提供者](https://huggingface.co/docs/inference-providers) 透過單一路由 API 提供與 OpenAI 相容的聊天補全服務。您只需一個 token 就能存取多種模型（DeepSeek、Llama 等）。OpenClaw 使用 **OpenAI 相容端點**（僅限聊天補全）；若要使用文字轉圖片、嵌入向量或語音，請直接使用 [HF 推論用戶端](https://huggingface.co/docs/api-inference/quicktour)。

- 提供者：`huggingface`
- 認證：`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`（細粒度 token，需包含 **呼叫推論提供者** 權限）
- API：OpenAI 相容（`https://router.huggingface.co/v1`）
- 計費：單一 HF token；[價格](https://huggingface.co/docs/inference-providers/pricing) 依提供者費率計算，並有免費額度。

## 快速開始

1. 在 [Hugging Face → 設定 → Token](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) 建立一個細粒度 token，並勾選 **呼叫推論提供者** 權限。
2. 執行入門流程，於提供者下拉選單選擇 **Hugging Face**，並在提示時輸入您的 API 金鑰：

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. 在 **預設 Hugging Face 模型** 下拉選單中，選擇您想使用的模型（當您擁有有效 token 時，列表會從推論 API 載入；否則會顯示內建列表）。您的選擇會被儲存為預設模型。
4. 您也可以稍後在設定中設定或更改預設模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
    },
  },
}
```

## 非互動範例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

這將設定 `huggingface/deepseek-ai/DeepSeek-R1` 為預設模型。

## 環境注意事項

如果 Gateway 以守護程序（launchd/systemd）方式執行，請確保 `HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN` 可供該程序使用（例如放在 `~/.openclaw/.env` 或透過 `env.shellEnv`）。

## 模型發現與入門下拉選單

OpenClaw 透過直接呼叫 **推論端點** 來發現模型：

```bash
GET https://router.huggingface.co/v1/models
```

（可選：傳送 `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` 或 `$HF_TOKEN` 以取得完整清單；部分端點在未授權時會回傳子集。）回應格式為 OpenAI 風格的 `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`。

當你設定 Hugging Face API 金鑰（透過入門流程、`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`）時，OpenClaw 會使用此 GET 請求來發現可用的聊天完成模型。在**互動式入門**階段，輸入 token 後會看到一個從該清單（或若請求失敗則為內建目錄）填充的**預設 Hugging Face 模型**下拉選單。執行時（例如 Gateway 啟動時），若有設定金鑰，OpenClaw 會再次呼叫 **GET** `https://router.huggingface.co/v1/models` 來更新目錄。該清單會與內建目錄合併（用於取得上下文視窗大小和費用等元資料）。若請求失敗或未設定金鑰，則僅使用內建目錄。

## 模型名稱與可編輯選項

- **API 名稱：** 模型顯示名稱會從 API 回傳的 GET /v1/models 中的 `name`、`title` 或 `display_name` 取得；若無，則由模型 ID 推導（例如 `deepseek-ai/DeepSeek-R1` → “DeepSeek R1”）。
- **覆寫顯示名稱：** 你可以在設定檔中為每個模型設定自訂標籤，讓它在 CLI 和 UI 中以你想要的方式顯示：

```json5
{
  agents: {
    defaults: {
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1 (fast)" },
        "huggingface/deepseek-ai/DeepSeek-R1:cheapest": { alias: "DeepSeek R1 (cheap)" },
      },
    },
  },
}
```

- **提供者 / 策略選擇：** 在 **模型 ID** 後加上後綴以選擇路由器如何挑選後端：
  - **`:fastest`** — 最高吞吐量（由路由器決定；提供者選擇**鎖定**，無互動式後端選擇器）。
  - **`:cheapest`** — 每輸出 token 最低成本（由路由器決定；提供者選擇**鎖定**）。
  - **`:provider`** — 強制指定特定後端（例如 `:sambanova`、`:together`）。

當你選擇 **:cheapest** 或 **:fastest**（例如在入門模型下拉選單中），提供者會被鎖定：路由器會依成本或速度決定，且不會顯示「偏好特定後端」的選項。你可以將這些作為獨立條目加入 `models.providers.huggingface.models`，或在 `model.primary` 中設定帶後綴的條目。你也可以在 [推理提供者設定](https://hf.co/settings/inference-providers) 中設定預設順序（無後綴即使用該順序）。

- **設定合併：** 當設定合併時，`models.providers.huggingface.models` 中現有的條目（例如在 `models.json`）會被保留。因此你在那裡設定的任何自訂 `name`、`alias` 或模型選項都會被保留。

## 模型 ID 與設定範例

模型參考使用 `huggingface/<org>/<model>` 形式（Hub 風格 ID）。以下清單來自 **GET** `https://router.huggingface.co/v1/models`；你的目錄可能包含更多。

**範例 ID（來自推理端點）：**

| 模型名稱               | 參考（前綴加上 `huggingface/`）     |
| ---------------------- | ----------------------------------- |
| DeepSeek R1            | `deepseek-ai/DeepSeek-R1`           |
| DeepSeek V3.2          | `deepseek-ai/DeepSeek-V3.2`         |
| Qwen3 8B               | `Qwen/Qwen3-8B`                     |
| Qwen2.5 7B Instruct    | `Qwen/Qwen2.5-7B-Instruct`          |
| Qwen3 32B              | `Qwen/Qwen3-32B`                    |
| Llama 3.3 70B Instruct | `meta-llama/Llama-3.3-70B-Instruct` |
| Llama 3.1 8B Instruct  | `meta-llama/Llama-3.1-8B-Instruct`  |
| GPT-OSS 120B           | `openai/gpt-oss-120b`               |
| GLM 4.7                | `zai-org/GLM-4.7`                   |
| Kimi K2.5              | `moonshotai/Kimi-K2.5`              |

你可以在模型 ID 後加上 `:fastest`、`:cheapest` 或 `:provider`（例如 `:together`、`:sambanova`）。在 [推理提供者設定](https://hf.co/settings/inference-providers) 中設定你的預設順序；詳見 [推理提供者](https://huggingface.co/docs/inference-providers) 以及 **GET** `https://router.huggingface.co/v1/models` 以取得完整清單。

### 完整設定範例

**主要 DeepSeek R1，備援使用 Qwen：**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-R1",
        fallbacks: ["huggingface/Qwen/Qwen3-8B"],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1" },
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
      },
    },
  },
}
```

**預設使用 Qwen，並提供 :cheapest 與 :fastest 變體：**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen3-8B" },
      models: {
        "huggingface/Qwen/Qwen3-8B": { alias: "Qwen3 8B" },
        "huggingface/Qwen/Qwen3-8B:cheapest": { alias: "Qwen3 8B (cheapest)" },
        "huggingface/Qwen/Qwen3-8B:fastest": { alias: "Qwen3 8B (fastest)" },
      },
    },
  },
}
```

**DeepSeek + Llama + GPT-OSS，搭配別名：**

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "huggingface/deepseek-ai/DeepSeek-V3.2",
        fallbacks: [
          "huggingface/meta-llama/Llama-3.3-70B-Instruct",
          "huggingface/openai/gpt-oss-120b",
        ],
      },
      models: {
        "huggingface/deepseek-ai/DeepSeek-V3.2": { alias: "DeepSeek V3.2" },
        "huggingface/meta-llama/Llama-3.3-70B-Instruct": { alias: "Llama 3.3 70B" },
        "huggingface/openai/gpt-oss-120b": { alias: "GPT-OSS 120B" },
      },
    },
  },
}
```

**強制指定後端使用 :provider：**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1:together" },
      models: {
        "huggingface/deepseek-ai/DeepSeek-R1:together": { alias: "DeepSeek R1 (Together)" },
      },
    },
  },
}
```

**多個 Qwen 與 DeepSeek 模型，搭配策略後綴：**

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest" },
      models: {
        "huggingface/Qwen/Qwen2.5-7B-Instruct": { alias: "Qwen2.5 7B" },
        "huggingface/Qwen/Qwen2.5-7B-Instruct:cheapest": { alias: "Qwen2.5 7B (cheap)" },
        "huggingface/deepseek-ai/DeepSeek-R1:fastest": { alias: "DeepSeek R1 (fast)" },
        "huggingface/meta-llama/Llama-3.1-8B-Instruct": { alias: "Llama 3.1 8B" },
      },
    },
  },
}
```
