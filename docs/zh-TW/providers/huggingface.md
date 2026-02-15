---
summary: "Hugging Face 推論設定 (憑證 + 模型選擇)"
read_when:
  - 您希望將 Hugging Face 推論與 OpenClaw 搭配使用
  - 您需要 HF token 環境變數或 CLI 憑證選項
title: "Hugging Face (推論)"
---

# Hugging Face (推論)

[Hugging Face 推論供應商](https://huggingface.co/docs/inference-providers) 透過單一路由 API 提供與 OpenAI 相容的聊天完成功能。您只需一個 token 即可存取許多模型 (DeepSeek、Llama 等)。OpenClaw 使用 **OpenAI 相容的端點** (僅限聊天完成)；對於文字轉圖片、嵌入或語音，請直接使用 [HF 推論用戶端](https://huggingface.co/docs/api-inference/quicktour)。

- 供應商: `huggingface`
- 憑證: `HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN` (具有「**Make calls to Inference Providers**」權限的細緻 token)
- API: OpenAI 相容 (`https://router.huggingface.co/v1`)
- 計費: 單一 HF token；[定價](https://huggingface.co/docs/inference-providers/pricing) 遵循供應商費率並提供免費方案。

## 快速開始

1. 在 [Hugging Face → Settings → Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) 建立一個具有「**Make calls to Inference Providers**」權限的細緻 token。
2. 執行新手導覽並在供應商下拉選單中選擇 **Hugging Face**，然後在提示時輸入您的 API 金鑰：

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. 在「**預設 Hugging Face 模型**」下拉選單中，選擇您想要的模型 (當您擁有有效 token 時，清單會從推論 API 載入；否則會顯示內建清單)。您的選擇將儲存為預設模型。
4. 您也可以稍後在設定中設定或變更預設模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
    },
  },
}
```

## 非互動式範例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

這會將 `huggingface/deepseek-ai/DeepSeek-R1` 設定為預設模型。

## 環境注意事項

如果 Gateway 以守護程序 (daemon) 執行 (launchd/systemd)，請確保該程序可以使用 `HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN` (例如，在 `~/.openclaw/.env` 或透過 `env.shellEnv`)。

## 模型探索與新手導覽下拉選單

OpenClaw 透過直接呼叫**推論端點**來探索模型：

```bash
GET https://router.huggingface.co/v1/models
```

(選用：發送 `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` 或 `$HF_TOKEN` 以獲取完整清單；某些端點在沒有憑證的情況下會回傳子集。) 回應是 OpenAI 樣式的 `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`。

當您設定 Hugging Face API 金鑰 (透過新手導覽、`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`) 時，OpenClaw 會使用此 GET 來探索可用的聊天完成模型。在**互動式新手導覽**期間，輸入 token 後，您會看到一個「**預設 Hugging Face 模型**」下拉選單，其中包含該清單中的模型 (如果請求失敗，則為內建目錄)。在執行時 (例如 Gateway 啟動時)，當存在金鑰時，OpenClaw 會再次呼叫 **GET** `https://router.huggingface.co/v1/models` 以重新整理目錄。該清單會與內建目錄合併 (用於上下文視窗和成本等中繼資料)。如果請求失敗或未設定金鑰，則只會使用內建目錄。

## 模型名稱與可編輯選項

- **來自 API 的名稱：** 當 API 回傳 `name`、`title` 或 `display_name` 時，模型顯示名稱會從 **GET /v1/models** 中**填充**；否則會從模型 ID 衍生 (例如 `deepseek-ai/DeepSeek-R1` → “DeepSeek R1”)。
- **覆寫顯示名稱：** 您可以在設定中為每個模型設定自訂標籤，使其在 CLI 和 UI 中以您希望的方式顯示：

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

- **供應商 / 策略選擇：** 在**模型 ID** 後面附加一個後綴，以選擇路由器如何選擇後端：
  - **`:fastest`** — 最高吞吐量 (路由器選擇；供應商選擇是**鎖定**的 — 沒有互動式後端選擇器)。
  - **`:cheapest`** — 每輸出 token 成本最低 (路由器選擇；供應商選擇是**鎖定**的)。
  - **`:provider`** — 強制使用特定的後端 (例如 `:sambanova`, `:together`)。

  當您選擇 **:cheapest** 或 **:fastest** (例如在新手導覽模型下拉選單中) 時，供應商會被鎖定：路由器根據成本或速度進行決定，並且不會顯示可選的「偏好特定後端」步驟。您可以將這些添加為 `models.providers.huggingface.models` 中的獨立項目，或將 `model.primary` 設定為帶有後綴。您也可以在 [推論供應商設定](https://hf.co/settings/inference-providers) 中設定您的預設順序 (沒有後綴 = 使用該順序)。

- **設定合併：** 當設定合併時，`models.providers.huggingface.models` (例如在 `models.json` 中) 中的現有項目將會保留。因此，您在那裡設定的任何自訂 `name`、`alias` 或模型選項都會保留。

## 模型 ID 和設定範例

模型參考使用 `huggingface/<org>/<model>` 形式 (Hub 樣式 ID)。以下清單來自 **GET** `https://router.huggingface.co/v1/models`；您的目錄可能包含更多。

**範例 ID (來自推論端點)：**

| 模型                  | 參考 (前綴為 `huggingface/`)    |
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

您可以在模型 ID 後面附加 `:fastest`、`:cheapest` 或 `:provider` (例如 `:together`、`:sambanova`)。在 [推論供應商設定](https://hf.co/settings/inference-providers) 中設定您的預設順序；請參閱 [推論供應商](https://huggingface.co/docs/inference-providers) 和 **GET** `https://router.huggingface.co/v1/models` 以獲取完整清單。

### 完整設定範例

**帶有 Qwen 備援的 DeepSeek R1 主要模型：**

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

**以 Qwen 作為預設，並提供 :cheapest 和 :fastest 變體：**

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

**帶有別名的 DeepSeek + Llama + GPT-OSS：**

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

**使用 :provider 強制使用特定後端：**

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

**帶有策略後綴的多個 Qwen 和 DeepSeek 模型：**

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
