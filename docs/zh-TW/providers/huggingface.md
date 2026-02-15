---
summary: "Hugging Face Inference 設定 (憑證 + 模型選擇)"
read_when:
  - 您想在 OpenClaw 中使用 Hugging Face Inference
  - 您需要 HF token 環境變數或 CLI 憑證選擇
  title: "Hugging Face (Inference)"
---

# Hugging Face (Inference)

[Hugging Face 推論供應商 (Inference Providers)](https://huggingface.co/docs/inference-providers) 透過單一的 router API 提供與 OpenAI 相容的聊天補完功能。您可以使用一個 token 存取多個模型（DeepSeek、Llama 等）。OpenClaw 使用 **OpenAI 相容的端點**（僅限聊天補完）；若要使用文字轉圖片、嵌入 (embeddings) 或語音功能，請直接使用 [HF 推論用戶端 (inference clients)](https://huggingface.co/docs/api-inference/quicktour)。

- 供應商：`huggingface`
- 憑證：`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`（需具備 **Make calls to Inference Providers** 權限的細粒度 token）
- API：OpenAI 相容 (`https://router.huggingface.co/v1`)
- 計費：單一 HF token；[價格](https://huggingface.co/docs/inference-providers/pricing) 依供應商費率計算，並提供免費額度。

## 快速開始

1. 在 [Hugging Face → Settings → Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) 建立一個具備 **Make calls to Inference Providers** 權限的細粒度 token。
2. 執行新手導覽，並在供應商下拉選單中選擇 **Hugging Face**，然後在提示時輸入您的 API 金鑰：

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. 在 **Default Hugging Face model** 下拉選單中，選擇您想要的模型（當您擁有有效的 token 時，列表會從推論 API 載入；否則將顯示內建目錄）。您的選擇將被儲存為預設模型。
4. 您稍後也可以在設定中設定或更改預設模型：

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

## 環境變數注意事項

如果 Gateway 作為背景程式 (launchd/systemd) 執行，請確保該處理程序可以存取 `HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`（例如，設定在 `~/.openclaw/.env` 或透過 `env.shellEnv`）。

## 模型探索與新手導覽下拉選單

OpenClaw 透過**直接呼叫推論端點**來探索模型：

```bash
GET https://router.huggingface.co/v1/models
```

（選填：發送 `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` 或 `$HF_TOKEN` 以取得完整列表；部分端點在未經憑證確認時僅回傳部分子集。）回應格式為 OpenAI 風格：`{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`。

當您設定 Hugging Face API 金鑰（透過新手導覽、`HUGGINGFACE_HUB_TOKEN` 或 `HF_TOKEN`）時，OpenClaw 會使用此 GET 請求來探索可用的聊天補完模型。在**互動式新手導覽**期間，輸入 token 後，您會看到一個從該列表生成的 **Default Hugging Face model** 下拉選單（若請求失敗則使用內建目錄）。在執行時（例如 Gateway 啟動時），若金鑰存在，OpenClaw 會再次呼叫 **GET** `https://router.huggingface.co/v1/models` 以更新目錄。此列表會與內建目錄合併（以取得上下文視窗和成本等中繼資料）。如果請求失敗或未設定金鑰，則僅使用內建目錄。

## 模型名稱與可編輯選項

- **來自 API 的名稱：** 當 API 回傳 `name`、`title` 或 `display_name` 時，模型顯示名稱會**自動填入**；否則將從模型 ID 推導（例如 `deepseek-ai/DeepSeek-R1` → “DeepSeek R1”）。
- **覆蓋顯示名稱：** 您可以在設定中為每個模型設定自定義標籤，使其在 CLI 和 UI 中以您想要的方式顯示：

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

- **供應商 / 策略選擇：** 在**模型 ID** 後面加上後綴，以選擇 router 挑選後端的方式：
  - **`:fastest`** — 最高吞吐量（由 router 選擇；供應商選擇已**鎖定** — 無需互動式後端選擇器）。
  - **`:cheapest`** — 每個輸出 token 的最低成本（由 router 選擇；供應商選擇已**鎖定**）。
  - **`:provider`** — 強制使用特定的後端（例如 `:sambanova`、`:together`）。

  當您選擇 **:cheapest** 或 **:fastest** 時（例如在新手導覽的模型下拉選單中），供應商會被鎖定：router 會根據成本或速度決定，且不會顯示選填的「偏好特定後端」步驟。您可以將這些作為獨立項目添加到 `models.providers.huggingface.models` 中，或在 `model.primary` 中設定帶有後綴的 ID。您也可以在 [推論供應商設定](https://hf.co/settings/inference-providers) 中設定您的預設順序（無後綴 = 使用該順序）。

- **設定合併：** 在合併設定時，`models.providers.huggingface.models` 中現有的項目（例如在 `models.json` 中）將被保留。因此，您在該處設定的任何自定義 `name`、`alias` 或模型選項都會被保留。

## 模型 ID 與設定範例

模型引用使用 `huggingface/<org>/<model>` 格式（Hub 風格 ID）。下表取自 **GET** `https://router.huggingface.co/v1/models`；您的目錄可能會包含更多項目。

**範例 ID（來自推論端點）：**

| 模型                   | 引用 (加上 `huggingface/` 前綴)     |
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

您可以在模型 ID 後面加上 `:fastest`、`:cheapest` 或 `:provider`（例如 `:together`、`:sambanova`）。請在 [推論供應商設定](https://hf.co/settings/inference-providers) 中設定您的預設順序；完整列表請參閱 [推論供應商 (Inference Providers)](https://huggingface.co/docs/inference-providers) 和 **GET** `https://router.huggingface.co/v1/models`。

### 完整設定範例

**主要模型為 DeepSeek R1 並以 Qwen 作為備援：**

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

**以 Qwen 為預設模型，並包含 :cheapest 與 :fastest 變體：**

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

**包含別名的 DeepSeek + Llama + GPT-OSS：**

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

**使用 :provider 強制指定特定後端：**

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

**多個帶有策略後綴的 Qwen 與 DeepSeek 模型：**

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
