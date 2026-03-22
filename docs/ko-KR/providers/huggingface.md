---
summary: "Hugging Face Inference 설정 (인증 + 모델 선택)"
read_when:
  - OpenClaw 에서 Hugging Face Inference 를 사용하고 싶을 때
  - HF 토큰 환경 변수 또는 CLI 인증 선택이 필요할 때
title: "Hugging Face (Inference)"
x-i18n:
  source_path: docs/providers/huggingface.md
---

# Hugging Face (Inference)

[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) 는 단일 라우터 API 를 통해 OpenAI 호환 채팅 완성을 제공합니다. 하나의 토큰으로 많은 모델 (DeepSeek, Llama 등) 에 액세스할 수 있습니다. OpenClaw 는 **OpenAI 호환 엔드포인트** (채팅 완성만) 를 사용합니다. 텍스트-이미지, 임베딩 또는 음성 변환은 [HF inference clients](https://huggingface.co/docs/api-inference/quicktour) 를 직접 사용하세요.

- 프로바이더: `huggingface`
- 인증: `HUGGINGFACE_HUB_TOKEN` 또는 `HF_TOKEN` (**Make calls to Inference Providers** 권한이 있는 세분화된 토큰)
- API: OpenAI 호환 (`https://router.huggingface.co/v1`)
- 과금: 단일 HF 토큰. [가격](https://huggingface.co/docs/inference-providers/pricing) 은 프로바이더 요금을 따르며 무료 티어가 있습니다.

## 빠른 시작

1. **Make calls to Inference Providers** 권한이 있는 세분화된 토큰을 [Hugging Face - Settings - Tokens](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained) 에서 생성하세요.
2. 온보딩을 실행하고 프로바이더 드롭다운에서 **Hugging Face** 를 선택한 다음, 프롬프트에 API 키를 입력하세요:

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. **Default Hugging Face model** 드롭다운에서 원하는 모델을 선택하세요 (유효한 토큰이 있으면 Inference API 에서 목록이 로드됩니다. 그렇지 않으면 내장 목록이 표시됩니다). 선택한 모델이 기본 모델로 저장됩니다.
4. 나중에 설정에서 기본 모델을 설정하거나 변경할 수도 있습니다:

```json5
{
  agents: {
    defaults: {
      model: { primary: "huggingface/deepseek-ai/DeepSeek-R1" },
    },
  },
}
```

## 비대화형 예제

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice huggingface-api-key \
  --huggingface-api-key "$HF_TOKEN"
```

이렇게 하면 `huggingface/deepseek-ai/DeepSeek-R1` 이 기본 모델로 설정됩니다.

## 환경 참고 사항

Gateway 가 데몬 (launchd/systemd) 으로 실행되는 경우, 해당 프로세스에서 `HUGGINGFACE_HUB_TOKEN` 또는 `HF_TOKEN` 이 사용 가능한지 확인하세요 (예: `~/.openclaw/.env` 또는 `env.shellEnv` 를 통해).

## 모델 검색 및 온보딩 드롭다운

OpenClaw 는 **Inference 엔드포인트를 직접** 호출하여 모델을 검색합니다:

```bash
GET https://router.huggingface.co/v1/models
```

(선택 사항: 전체 목록을 위해 `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` 또는 `$HF_TOKEN` 을 전송하세요. 일부 엔드포인트는 인증 없이 일부만 반환합니다.) 응답은 OpenAI 스타일 `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }` 입니다.

Hugging Face API 키를 설정하면 (온보딩, `HUGGINGFACE_HUB_TOKEN` 또는 `HF_TOKEN` 을 통해), OpenClaw 는 이 GET 을 사용하여 사용 가능한 채팅 완성 모델을 검색합니다. **대화형 설정** 중 토큰을 입력하면 해당 목록에서 채워진 **Default Hugging Face model** 드롭다운이 표시됩니다 (요청이 실패하면 내장 카탈로그 사용). 런타임 (예: Gateway 시작) 에서 키가 있으면 OpenClaw 는 다시 **GET** `https://router.huggingface.co/v1/models` 를 호출하여 카탈로그를 새로 고칩니다. 목록은 내장 카탈로그 (컨텍스트 윈도우 및 비용과 같은 메타데이터용) 와 병합됩니다. 요청이 실패하거나 키가 설정되지 않은 경우 내장 카탈로그만 사용됩니다.

## 모델 이름 및 편집 가능한 옵션

- **API 에서의 이름:** 모델 표시 이름은 API 가 `name`, `title` 또는 `display_name` 을 반환할 때 **GET /v1/models 에서 하이드레이트** 됩니다. 그렇지 않으면 모델 ID 에서 파생됩니다 (예: `deepseek-ai/DeepSeek-R1` -> "DeepSeek R1").
- **표시 이름 재정의:** 설정에서 모델별로 사용자 정의 레이블을 설정하여 CLI 및 UI 에서 원하는 방식으로 표시할 수 있습니다:

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

- **프로바이더/정책 선택:** **모델 ID** 에 접미사를 추가하여 라우터가 백엔드를 선택하는 방식을 결정합니다:
  - **`:fastest`** -- 최고 처리량 (라우터가 선택; 프로바이더 선택이 **잠김** -- 대화형 백엔드 선택기 없음).
  - **`:cheapest`** -- 출력 토큰당 최저 비용 (라우터가 선택; 프로바이더 선택이 **잠김**).
  - **`:provider`** -- 특정 백엔드 강제 (예: `:sambanova`, `:together`).

  **:cheapest** 또는 **:fastest** 를 선택하면 (예: 온보딩 모델 드롭다운에서), 프로바이더가 잠김: 라우터가 비용이나 속도로 결정하며 선택적 "특정 백엔드 선호" 단계가 표시되지 않습니다. 이를 `models.providers.huggingface.models` 에 별도 항목으로 추가하거나 접미사와 함께 `model.primary` 를 설정할 수 있습니다. [Inference Provider 설정](https://hf.co/settings/inference-providers) 에서 기본 순서를 설정할 수도 있습니다 (접미사 없음 = 해당 순서 사용).

- **설정 병합:** `models.providers.huggingface.models` 의 기존 항목 (예: `models.json`) 은 설정 병합 시 유지됩니다. 따라서 거기에 설정한 사용자 정의 `name`, `alias` 또는 모델 옵션이 보존됩니다.

## 모델 ID 및 설정 예제

모델 참조는 `huggingface/<org>/<model>` 형식 (Hub 스타일 ID) 을 사용합니다. 아래 목록은 **GET** `https://router.huggingface.co/v1/models` 에서 가져온 것입니다. 카탈로그에 더 많은 것이 포함될 수 있습니다.

**예제 ID (inference 엔드포인트에서):**

| 모델                   | 참조 (`huggingface/` 접두사 추가)   |
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

모델 ID 에 `:fastest`, `:cheapest` 또는 `:provider` (예: `:together`, `:sambanova`) 를 추가할 수 있습니다. [Inference Provider 설정](https://hf.co/settings/inference-providers) 에서 기본 순서를 설정하세요. [Inference Providers](https://huggingface.co/docs/inference-providers) 및 **GET** `https://router.huggingface.co/v1/models` 에서 전체 목록을 확인하세요.

### 전체 설정 예제

**기본 DeepSeek R1 과 Qwen 폴백:**

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

**Qwen 을 기본으로, :cheapest 및 :fastest 변형 포함:**

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

**DeepSeek + Llama + GPT-OSS 별칭 포함:**

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

**:provider 로 특정 백엔드 강제:**

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

**정책 접미사가 있는 다중 Qwen 및 DeepSeek 모델:**

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
