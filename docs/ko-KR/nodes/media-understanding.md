---
summary: "Inbound image/audio/video understanding (optional) with provider + CLI fallbacks"
read_when:
  - Designing or refactoring media understanding
  - Tuning inbound audio/video/image preprocessing
title: "Media Understanding"
x-i18n:
  source_hash: 4b275b152060eae30b61cd9f818fe1cc13a2ef7d82ec6c9992b96e11f8759387
---

# 미디어 이해 (인바운드) — 2026-01-17

OpenClaw는 응답 파이프라인이 실행되기 전에 **인바운드 미디어**(이미지/오디오/비디오)를 요약할 수 있습니다. 로컬 도구나 공급자 키를 사용할 수 있는 시기를 자동으로 감지하며 비활성화하거나 사용자 정의할 수 있습니다. 이해가 어려운 경우에도 모델은 평소대로 원본 파일/URL을 수신합니다.

## 목표

- 선택 사항: 더 빠른 라우팅 + 더 나은 명령 구문 분석을 위해 인바운드 미디어를 짧은 텍스트로 사전 요약합니다.
- 모델에 전달된 원본 미디어를 항상 유지합니다.
- **공급자 API** 및 **CLI 대체**를 지원합니다.
- 순서대로 대체(오류/크기/시간 초과)된 여러 모델을 허용합니다.

## 높은 수준의 동작

1. 인바운드 첨부파일(`MediaPaths`, `MediaUrls`, `MediaTypes`)을 수집합니다.
2. 활성화된 각 기능(이미지/오디오/비디오)에 대해 정책별로 첨부 파일을 선택합니다(기본값: **먼저**).
3. 첫 번째 적격 모델 항목(크기 + 기능 + 인증)을 선택합니다.
4. 모델이 실패하거나 미디어가 너무 큰 경우 **다음 항목으로 돌아갑니다**.
5. 성공 시:
   - `Body`는 `[Image]`, `[Audio]` 또는 `[Video]` 블록이 됩니다.
   - 오디오 세트 `{{Transcript}}`; 명령 구문 분석은 캡션 텍스트가 있는 경우 이를 사용합니다.
     그렇지 않으면 성적표.
   - 캡션은 블록 내부에 `User text:`로 유지됩니다.

이해가 실패하거나 비활성화된 경우 원본 본문과 첨부 파일을 사용하여 **응답 흐름이 계속됩니다**.

## 구성 개요

`tools.media`는 **공유 모델**과 기능별 재정의를 지원합니다.

- `tools.media.models`: 공유 모델 목록(게이트하려면 `capabilities` 사용).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - 기본값 (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - 공급자 재정의 (`baseUrl`, `headers`, `providerOptions`)
  - `tools.media.audio.providerOptions.deepgram`를 통한 딥그램 오디오 옵션
  - 선택 사항 **기능별 `models` 목록** (공유 모델 이전에 선호됨)
  - `attachments` 정책 (`mode`, `maxAttachments`, `prefer`)
  - `scope` (채널/chatType/세션 키에 의한 선택적 게이팅)
- `tools.media.concurrency`: 최대 동시 실행 능력(기본값 **2**).

```json5
{
  tools: {
    media: {
      models: [
        /* shared list */
      ],
      image: {
        /* optional overrides */
      },
      audio: {
        /* optional overrides */
      },
      video: {
        /* optional overrides */
      },
    },
  },
}
```

### 모델 항목

각 `models[]` 항목은 **공급자** 또는 **CLI**일 수 있습니다.

```json5
{
  type: "provider", // default if omitted
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // optional, used for multi‑modal entries
  profile: "vision-profile",
  preferredProfile: "vision-fallback",
}
```

```json5
{
  type: "cli",
  command: "gemini",
  args: [
    "-m",
    "gemini-3-flash",
    "--allowed-tools",
    "read_file",
    "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
}
```

CLI 템플릿은 다음을 사용할 수도 있습니다.

- `{{MediaDir}}` (미디어 파일이 포함된 디렉터리)
- `{{OutputDir}}` (이 실행을 위해 생성된 스크래치 디렉터리)
- `{{OutputBase}}` (스크래치 파일 기본 경로, 확장자 없음)

## 기본값 및 제한

권장 기본값:

- `maxChars`: 이미지/비디오용 **500**(짧은 명령 친화적)
- `maxChars`: 오디오 **설정 해제**(제한을 설정하지 않는 한 전체 내용 기록)
- `maxBytes`:
  - 이미지: **10MB**
  - 오디오: **20MB**
  - 비디오: **50MB**

규칙:

- 미디어가 `maxBytes`를 초과하는 경우 해당 모델을 건너뛰고 **다음 모델을 시도**합니다.
- 모델이 `maxChars` 이상을 반환하는 경우 출력이 잘립니다.
- `prompt` 기본값은 간단한 "{미디어} 설명"입니다. 또한 `maxChars` 안내(이미지/비디오만 해당).
- `<capability>.enabled: true`이지만 구성된 모델이 없으면 OpenClaw는 다음을 시도합니다.
  **활성 응답 모델** 제공자가 해당 기능을 지원하는 경우.

### 미디어 이해 자동 감지(기본값)

`tools.media.<capability>.enabled`가 `false`로 설정되지 **않은** 경우
구성된 모델에서는 OpenClaw가 이 순서대로 자동 감지하고 **첫 번째에서 중지합니다.
작업 옵션**:

1. **로컬 CLI**(오디오 전용, 설치된 경우)
   - `sherpa-onnx-offline` (인코더/디코더/조이너/토큰과 함께 `SHERPA_ONNX_MODEL_DIR` 필요)
   - `whisper-cli` (`whisper-cpp`; `WHISPER_CPP_MODEL` 또는 번들로 제공되는 소형 모델을 사용함)
   - `whisper` (Python CLI; 자동으로 모델 다운로드)
2. **Gemini CLI** (`gemini`) `read_many_files` 사용
3. **공급자 키**
   - 오디오: OpenAI → Groq → Deepgram → Google
   - 이미지: OpenAI → Anthropic → Google → MiniMax
   - 영상: 구글

자동 감지를 비활성화하려면 다음을 설정하십시오.

```json5
{
  tools: {
    media: {
      audio: {
        enabled: false,
      },
    },
  },
}
```

참고: 바이너리 감지는 macOS/Linux/Windows에서 최선의 노력을 다합니다. CLI가 `PATH`에 있는지 확인하거나(`~` 확장) ​​전체 명령 경로를 사용하여 명시적인 CLI 모델을 설정합니다.

## 기능(선택 사항)

`capabilities`를 설정하면 해당 미디어 유형에 대해서만 항목이 실행됩니다. 공유용
목록을 통해 OpenClaw는 기본값을 추론할 수 있습니다.

- `openai`, `anthropic`, `minimax`: **이미지**
- `google` (Gemini API): **이미지 + 오디오 + 비디오**
- `groq`: **오디오**
- `deepgram`: **오디오**

CLI 항목의 경우 예상치 못한 일치를 방지하려면 **`capabilities`를 명시적으로 설정**하세요.
`capabilities`를 생략하면 항목이 나타나는 목록에 적합합니다.

## 공급자 지원 매트릭스(OpenClaw 통합)

| 능력   | 공급자 통합                                       | 메모                                             |
| ------ | ------------------------------------------------- | ------------------------------------------------ |
| 이미지 | `pi-ai`를 통한 OpenAI / Anthropic / Google / 기타 | 레지스트리의 모든 이미지 지원 모델이 작동합니다. |
| 오디오 | OpenAI, Groq, Deepgram, 구글                      | 공급자 전사(Whisper/Deepgram/Gemini).            |
| 비디오 | 구글(제미니 API)                                  | 제공자 비디오 이해.                              |

## 추천 제공업체

**이미지**

- 이미지를 지원하는 경우 활성 모델을 선호하세요.
- 적절한 기본값: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**오디오**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo` 또는 `deepgram/nova-3`.
- CLI 대체: `whisper-cli` (whisper-cpp) 또는 `whisper`.
- 딥그램 설정: [딥그램(오디오 전사)](/providers/deepgram).

**동영상**

- `google/gemini-3-flash-preview`(빠름), `google/gemini-3-pro-preview`(더 풍부함).
- CLI 대체: `gemini` CLI(비디오/오디오에서 `read_file` 지원).

## 첨부파일 정책

기능별 `attachments`는 처리되는 첨부 파일을 제어합니다.

- `mode`: `first` (기본값) 또는 `all`
- `maxAttachments`: 처리 횟수 제한 (기본값 **1**)
- `prefer`: `first`, `last`, `path`, `url`

`mode: "all"`인 경우 출력에는 `[Image 1/2]`, `[Audio 2/2]` 등으로 라벨이 지정됩니다.

## 구성 예

### 1) 공유 모델 목록 + 재정의

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },
        {
          provider: "google",
          model: "gemini-3-flash-preview",
          capabilities: ["image", "audio", "video"],
        },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
          ],
          capabilities: ["image", "video"],
        },
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 },
      },
      video: {
        maxChars: 500,
      },
    },
  },
}
```

### 2) 오디오 + 비디오만(이미지 꺼짐)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
          },
        ],
      },
      video: {
        enabled: true,
        maxChars: 500,
        models: [
          { provider: "google", model: "gemini-3-flash-preview" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 3) 선택적 이미지 이해

```json5
{
  tools: {
    media: {
      image: {
        enabled: true,
        maxBytes: 10485760,
        maxChars: 500,
        models: [
          { provider: "openai", model: "gpt-5.2" },
          { provider: "anthropic", model: "claude-opus-4-6" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Read the media at {{MediaPath}} and describe it in <= {{MaxChars}} characters.",
            ],
          },
        ],
      },
    },
  },
}
```

### 4) 다중 모드 단일 항목(명시적 기능)

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## 상태 출력

미디어 이해가 실행되면 `/status`에는 짧은 요약 줄이 포함됩니다.

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

이는 기능별 결과와 해당하는 경우 선택한 공급자/모델을 보여줍니다.

## 메모

- 이해는 **최선의 노력**입니다. 오류는 응답을 차단하지 않습니다.
- 이해가 비활성화된 경우에도 첨부 파일은 계속 모델에 전달됩니다.
- `scope`를 사용하여 이해가 실행되는 범위를 제한합니다(예: DM만).

## 관련 문서

- [구성](/gateway/configuration)
- [이미지 및 미디어 지원](/nodes/images)
