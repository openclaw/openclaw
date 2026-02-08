---
read_when:
    - 미디어 이해 설계 또는 리팩토링
    - 인바운드 오디오/비디오/이미지 전처리 조정
summary: 공급자 + CLI 폴백을 통한 인바운드 이미지/오디오/비디오 이해(선택 사항)
title: 미디어 이해
x-i18n:
    generated_at: "2026-02-08T15:58:56Z"
    model: gtx
    provider: google-translate
    source_hash: 4b275b152060eae30b61cd9f818fe1cc13a2ef7d82ec6c9992b96e11f8759387
    source_path: nodes/media-understanding.md
    workflow: 15
---

# 미디어 이해 (인바운드) — 2026-01-17

OpenClaw는 할 수 있습니다 **인바운드 미디어 요약** (이미지/오디오/비디오) 응답 파이프라인이 실행되기 전에. 로컬 도구나 공급자 키를 사용할 수 있는 시기를 자동으로 감지하며 비활성화하거나 사용자 정의할 수 있습니다. 이해가 어려운 경우에도 모델은 평소대로 원본 파일/URL을 수신합니다.

## 목표

- 선택 사항: 더 빠른 라우팅 + 더 나은 명령 구문 분석을 위해 인바운드 미디어를 짧은 텍스트로 사전 요약합니다.
- 모델에 대한 원본 미디어 전달을 항상 유지합니다.
- 지원하다 **공급자 API** 그리고 **CLI 대체**.
- 순서가 지정된 폴백(오류/크기/시간 초과)이 있는 여러 모델을 허용합니다.

## 높은 수준의 동작

1. 인바운드 첨부 파일 수집(`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. 활성화된 각 기능(이미지/오디오/비디오)에 대해 정책별로 첨부 파일을 선택합니다(기본값: **첫 번째**).
3. 첫 번째 적격 모델 항목(크기 + 기능 + 인증)을 선택합니다.
4. 모델이 실패하거나 미디어가 너무 큰 경우 **다음 항목으로 돌아갑니다.**.
5. 성공 시:
   - `Body` 된다 `[Image]`, `[Audio]`, 또는 `[Video]` 차단하다.
   - 오디오 세트 `{{Transcript}}`; 명령 구문 분석은 캡션 텍스트가 있는 경우 이를 사용합니다.
     그렇지 않으면 성적표.
   - 캡션은 다음과 같이 유지됩니다. `User text:` 블록 내부.

이해가 실패하거나 비활성화된 경우, **응답 흐름은 계속됩니다** 본체+부속품 포함.

## 구성 개요

`tools.media` 지원하다 **공유 모델** 게다가 기능별 재정의:

- `tools.media.models`: 공유 모델 목록(사용 `capabilities` 게이트로).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - 기본값(`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - 공급자 재정의(`baseUrl`, `headers`, `providerOptions`)
  - Deepgram 오디오 옵션을 통해 `tools.media.audio.providerOptions.deepgram`
  - 선택 과목 **기능별 `models` 목록** (공유 모델보다 선호됨)
  - `attachments` 정책 (`mode`, `maxAttachments`, `prefer`)
  - `scope` (채널/chatType/세션 키에 따른 선택적 게이팅)
- `tools.media.concurrency`: 최대 동시 실행 능력(기본값) **2**).

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

각 `models[]` 입장은 가능하다 **공급자** 또는 **CLI**:

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

## 기본값 및 한도

권장 기본값:

- `maxChars`:**500** 이미지/비디오용(짧고 명령 친화적)
- `maxChars`:**설정되지 않음** 오디오용(제한을 설정하지 않는 한 전체 내용 기록)
- `maxBytes`:
  - 영상: **10MB**
  - 오디오: **20MB**
  - 동영상: **50MB**

규칙:

- 미디어가 초과하는 경우 `maxBytes`, 해당 모델은 건너뛰고 **다음 모델이 시도됩니다**.
- 모델이 다음 이상을 반환하는 경우 `maxChars`, 출력이 잘립니다.
- `prompt` 기본값은 간단한 '{미디어} 설명'입니다. 게다가 `maxChars` 안내(이미지/동영상만 해당).
- 만약에 `<capability>.enabled: true` 모델이 구성되어 있지 않으면 OpenClaw가 다음을 시도합니다.
  **활성 응답 모델** 공급자가 해당 기능을 지원할 때.

### 미디어 이해 자동 감지(기본값)

만약에 `tools.media.<capability>.enabled` ~이다 **~ 아니다** 로 설정 `false` 그리고 당신은하지 않았습니다
구성된 모델, OpenClaw는 이 순서대로 자동 감지하고 **처음에 멈춘다
작업 옵션**:

1. **로컬 CLI** (오디오 전용, 설치된 경우)
   - `sherpa-onnx-offline` (요구 `SHERPA_ONNX_MODEL_DIR` 인코더/디코더/조이너/토큰 포함)
   - `whisper-cli` (`whisper-cpp`; 용도 `WHISPER_CPP_MODEL` 또는 번들로 제공되는 소형 모델)
   - `whisper` (Python CLI; 자동으로 모델 다운로드)
2. **제미니 CLI** (`gemini`) 사용 `read_many_files`
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

참고: 바이너리 감지는 macOS/Linux/Windows에서 최선의 노력을 다합니다. CLI가 켜져 있는지 확인하세요 `PATH` (우리는 확장 `~`) 또는 전체 명령 경로를 사용하여 명시적인 CLI 모델을 설정합니다.

## 기능(선택 사항)

설정하면 `capabilities`, 해당 미디어 유형에 대해서만 항목이 실행됩니다. 공유용
목록을 통해 OpenClaw는 기본값을 추론할 수 있습니다.

- `openai`, `anthropic`, `minimax`:**영상**
- `google` (제미니 API): **이미지 + 오디오 + 비디오**
- `groq`:**오디오**
- `deepgram`:**오디오**

CLI 항목의 경우 **세트 `capabilities` 명시적으로** 예상치 못한 경기를 피하기 위해.
생략하는 경우 `capabilities`, 항목이 나타나는 목록에 적합합니다.

## 공급자 지원 매트릭스(OpenClaw 통합)

| Capability | Provider integration                             | Notes                                             |
| ---------- | ------------------------------------------------ | ------------------------------------------------- |
| Image      | OpenAI / Anthropic / Google / others via `pi-ai` | Any image-capable model in the registry works.    |
| Audio      | OpenAI, Groq, Deepgram, Google                   | Provider transcription (Whisper/Deepgram/Gemini). |
| Video      | Google (Gemini API)                              | Provider video understanding.                     |

## 추천 제공업체

**영상**

- 이미지를 지원하는 경우 활성 모델을 선호하세요.
- 좋은 기본값: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**오디오**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo`, 또는 `deepgram/nova-3`.
- CLI 대체: `whisper-cli` (속삭임-cpp) 또는 `whisper`.
- 딥그램 설정: [Deepgram(오디오 전사)](/providers/deepgram).

**동영상**

- `google/gemini-3-flash-preview` (빠른), `google/gemini-3-pro-preview` (더 부자).
- CLI 대체: `gemini` CLI(지원 `read_file` 비디오/오디오).

## 첨부파일 정책

기능별 `attachments` 처리되는 첨부 파일을 제어합니다.

- `mode`:`first` (기본값) 또는 `all`
- `maxAttachments`: 처리된 수를 제한합니다(기본값 **1**)
- `prefer`:`first`, `last`, `path`, `url`

언제 `mode: "all"`, 출력에는 라벨이 붙어 있습니다. `[Image 1/2]`, `[Audio 2/2]`, 등.

## 구성 예시

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

미디어 이해가 실행되면, `/status` 짧은 요약 줄을 포함합니다:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

이는 기능별 결과와 해당하는 경우 선택한 공급자/모델을 보여줍니다.

## 메모

- 이해는 **최선의 노력**. 오류는 응답을 차단하지 않습니다.
- 이해가 비활성화된 경우에도 첨부 파일은 여전히 ​​모델에 전달됩니다.
- 사용 `scope` 이해가 실행되는 범위를 제한합니다(예: DM만).

## 관련 문서

- [구성](/gateway/configuration)
- [이미지 및 미디어 지원](/nodes/images)
