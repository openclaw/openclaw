---
summary: "Hugging Face 추론 설정 (인증 + 모델 선택)"
read_when:
  - OpenClaw에서 Hugging Face 추론을 사용하고 싶을 때
  - HF 토큰 환경 변수 또는 CLI 인증 선택이 필요할 때
title: "Hugging Face (추론)"
---

# Hugging Face (추론)

[Hugging Face 추론 프로바이더](https://huggingface.co/docs/inference-providers)는 OpenAI 호환 채팅 완성을 위한 단일 라우터 API를 제공합니다. 하나의 토큰으로 여러 모델(DeepSeek, Llama 등)에 접근할 수 있습니다. OpenClaw는 **OpenAI 호환 엔드포인트**만 사용하며 (채팅 완성 전용); 텍스트-이미지, 임베딩 또는 음성 등의 경우 [HF 추론 클라이언트](https://huggingface.co/docs/api-inference/quicktour)를 직접 사용하십시오.

- 프로바이더: `huggingface`
- 인증: `HUGGINGFACE_HUB_TOKEN` 또는 `HF_TOKEN` (세분화된 토큰이며 **추론 프로바이더에 호출 수행** 권한 필요)
- API: OpenAI 호환 (`https://router.huggingface.co/v1`)
- 청구: 단일 HF 토큰; [가격](https://huggingface.co/docs/inference-providers/pricing)은 프로바이더 요율을 따르며 무료 계층 포함.

## 빠른 시작

1. [Hugging Face → 설정 → 토큰](https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained)에서 **추론 프로바이더에 호출 수행** 권한이 있는 세분화된 토큰을 생성하십시오.
2. 온보딩을 실행하고 프로바이더 드롭다운에서 **Hugging Face**를 선택한 후, 요청 시 API 키를 입력하세요:

```bash
openclaw onboard --auth-choice huggingface-api-key
```

3. **기본 Hugging Face 모델** 드롭다운에서 원하는 모델을 선택하세요 (유효한 토큰이 있는 경우 추론 API에서 목록을 로드합니다; 그렇지 않으면 내장된 목록이 표시됨). 선택한 모델은 기본 모델로 저장됩니다.
4. 또한 나중에 설정에서 기본 모델을 설정하거나 변경할 수 있습니다:

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

이것은 기본 모델로 `huggingface/deepseek-ai/DeepSeek-R1`을 설정할 것입니다.

## 환경 주의

게이트웨이가 데몬(launchd/systemd)으로 실행되면 해당 프로세스에 `HUGGINGFACE_HUB_TOKEN` 또는 `HF_TOKEN`
이 사용 가능해야 합니다. (예: `~/.openclaw/.env` 또는 `env.shellEnv`를 통해).

## 모델 검색 및 온보딩 드롭다운

OpenClaw는 **추론 엔드포인트를 직접 호출**하여 모델을 검색합니다:

```bash
GET https://router.huggingface.co/v1/models
```

(선택 사항: 전체 목록을 위해 `Authorization: Bearer $HUGGINGFACE_HUB_TOKEN` 또는 `$HF_TOKEN`을 전송하십시오; 일부 엔드포인트는 인증 없이 일부 일을 반환합니다.) 응답은 OpenAI 스타일의 `{ "object": "list", "data": [ { "id": "Qwen/Qwen3-8B", "owned_by": "Qwen", ... }, ... ] }`로 구성됩니다.

Hugging Face API 키를 구성할 때 (온보딩, `HUGGINGFACE_HUB_TOKEN`, 또는 `HF_TOKEN`을 통해), OpenClaw는 사용 가능한 채팅 완성 모델을 검색하기 위해 이 GET을 사용합니다. **대화형 온보딩** 중, 토큰을 입력한 후 이 목록으로부터 채워진 **기본 Hugging Face 모델** 드롭다운을 보게 됩니다 (요청 실패 시 내장된 카탈로그 사용). 런타임 시 (예: 게이트웨이 시작 시), 키가 있으면 OpenClaw가 다시 **GET** `https://router.huggingface.co/v1/models`을 호출하여 카탈로그를 새로고침합니다. 목록은 내장된 카탈로그와 병합됩니다 (컨텍스트 윈도우 및 비용과 같은 메타데이터 위해). 요청 실패 또는 키 설정이 없으면 내장된 카탈로그만 사용됩니다.

## 모델 이름 및 편집 가능한 옵션

- **API에서 가져온 이름:** API가 `name`, `title`, 또는 `display_name`을 반환할 때 **GET /v1/models**에서 모델 표시 이름을 조정합니다; 그렇지 않으면 모델 ID로부터 파생됩니다 (예: `deepseek-ai/DeepSeek-R1` → “DeepSeek R1”).
- **표시 이름 재정의:** 구성에서 모델별 사용자 정의 라벨을 설정하여 CLI 및 UI에서 원하는 방식으로 표시되게 할 수 있습니다:

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

- **프로바이더 / 정책 선택:** **모델 id**에 접미사를 추가하여 라우터가 백엔드를 선택하는 방법을 결정할 수 있습니다:
  - **`:fastest`** — 가장 높은 처리량 (라우터 결정; 프로바이더 선택은 **잠김** — 대화형 백엔드 선택기 없음).
  - **`:cheapest`** — 출력 토큰당 가장 낮은 비용 (라우터 결정; 프로바이더 선택은 **잠김**).
  - **`:provider`** — 특정 백엔드를 강제로 사용 (예: `:sambanova`, `:together`).

  **:cheapest** 또는 **:fastest**를 선택하면 (예: 온보딩 모델 드롭다운에서), 프로바이더가 잠기게 됩니다: 라우터는 비용 또는 속도로 결정하며 "특정 백엔드를 선호" 선택지가 나타나지 않습니다. 이러한 항목을 `models.providers.huggingface.models`에 별도의 항목으로 추가하거나 접미사로 `model.primary`를 설정할 수 있습니다. [추론 프로바이더 설정](https://hf.co/settings/inference-providers)에서 기본 순서를 설정할 수 있습니다 (접미사 없음 = 해당 순서 사용).

- **구성 병합:** `models.providers.huggingface.models`의 기존 항목 (예: `models.json` 내)은 구성 병합 시 유지됩니다. 따라서 거기 설정된 `name`, `alias`, 또는 모델 옵션은 보존됩니다.

## 모델 ID 및 구성 예제

모델 참조는 `huggingface/<org>/<model>` (허브 스타일 ID) 형식을 사용합니다. 아래 목록은 **GET** `https://router.huggingface.co/v1/models`에서 가져온 것이며; 당신의 카탈로그에는 더 많은 것이 포함될 수 있습니다.

**예제 ID (추론 엔드포인트에서 가져옴):**

| 모델                     | 참조 (앞에 `huggingface/` 추가)       |
| ----------------------- | ----------------------------------- |
| DeepSeek R1             | `deepseek-ai/DeepSeek-R1`           |
| DeepSeek V3.2           | `deepseek-ai/DeepSeek-V3.2`         |
| Qwen3 8B                | `Qwen/Qwen3-8B`                     |
| Qwen2.5 7B Instruct     | `Qwen/Qwen2.5-7B-Instruct`          |
| Qwen3 32B               | `Qwen/Qwen3-32B`                    |
| Llama 3.3 70B Instruct  | `meta-llama/Llama-3.3-70B-Instruct` |
| Llama 3.1 8B Instruct   | `meta-llama/Llama-3.1-8B-Instruct`  |
| GPT-OSS 120B            | `openai/gpt-oss-120b`               |
| GLM 4.7                 | `zai-org/GLM-4.7`                   |
| Kimi K2.5               | `moonshotai/Kimi-K2.5`              |

모델 id에 `:fastest`, `:cheapest`, 또는 `:provider` (예: `:together`, `:sambanova`)를 추가할 수 있습니다. [추론 프로바이더 설정](https://hf.co/settings/inference-providers)에서 기본 순서를 설정하세요; 전체 목록은 [추론 프로바이더](https://huggingface.co/docs/inference-providers) 및 **GET** `https://router.huggingface.co/v1/models`를 참조하세요.

### 완전한 구성 예제

**Qwen 백업이 있는 기본 DeepSeek R1:**

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

**기본 Qwen, :cheapest 및 :fastest 변형 포함:**

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

**:provider를 사용하여 특정 백엔드 강제 설정:**

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

**정책 접미사가 있는 여러 Qwen 및 DeepSeek 모델:**

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
