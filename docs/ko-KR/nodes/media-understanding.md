---
summary: "Inbound image/audio/video understanding (optional) with provider + CLI fallbacks"
read_when:
  - 미디어 이해를 설계하거나 리팩토링할 때
  - 인바운드 오디오/비디오/이미지 사전 처리 조정 시
title: "미디어 이해"
---

# 미디어 이해 (인바운드) — 2026-01-17

OpenClaw는 응답 파이프라인이 실행되기 전에 인바운드 미디어(이미지/오디오/비디오)를 요약할 수 있습니다. 로컬 도구 또는 프로바이더 키가 사용 가능할 때 이를 자동으로 감지하며, 비활성화하거나 사용자 지정할 수 있습니다. 이해가 꺼져 있는 경우에도 모델은 여전히 원본 파일/URL을 평소와 같이 받습니다.

## 목표

- 선택 사항: 인바운드 미디어를 짧은 텍스트로 미리 압축하여 빠른 라우팅 및 더 나은 명령어 해석 지원.
- 원본 미디어 전달을 모델로 그대로 유지 (항상).
- **프로바이더 API** 및 **CLI 폴백** 지원.
- 순서가 지정된 폴백을 사용하여 여러 모델 허용 (오류/크기/시간 초과).

## 상위 수준 동작

1. 인바운드 첨부 파일 수집 (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. 각 활성화된 기능(이미지/오디오/비디오)에 대해 정책별로 첨부 파일 선택 (기본값: **first**).
3. 첫 번째 적격 모델 항목 선택 (크기 + 기능 + 인증).
4. 모델이 실패하거나 미디어가 너무 큰 경우 **다음 항목으로 폴백**.
5. 성공 시:
   - `Body`는 `[Image]`, `[Audio]`, `[Video]` 블록이 됩니다.
   - 오디오는 `{{Transcript}}`를 설정합니다. 명령어 해석은 캡션 텍스트가 있을 때 이를 사용하고, 그렇지 않으면 전사본을 사용합니다.
   - 캡션은 블록 내의 `User text:`로 보존됩니다.

이해가 실패하거나 비활성화된 경우, **응답 흐름은** 원래 본문과 첨부 파일을 사용하여 계속됩니다.

## 설정 개요

`tools.media`는 **공유 모델**과 기능별로 재정의할 수 있는 내용을 지원합니다:

- `tools.media.models`: 공유 모델 목록 (`capabilities`로 게이트 설정).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - 기본값 (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - 프로바이더 재정의 (`baseUrl`, `headers`, `providerOptions`)
  - `tools.media.audio.providerOptions.deepgram`을 통한 Deepgram 오디오 옵션
  - 선택 사항 **기능별 `models` 목록** (공유 모델보다 우선 사용)
  - `attachments` 정책 (`mode`, `maxAttachments`, `prefer`)
  - `scope` (채널/채팅 유형/세션 키별로 옵션 설정 가능)
- `tools.media.concurrency`: 최대 동시 기능 실행 수 (기본값 **2**).

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

각 `models[]` 항목은 **프로바이더** 또는 **CLI**일 수 있습니다:

```json5
{
  type: "provider", // 생략 시 기본값
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe the image in <= 500 chars.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // 선택 사항, 다중 모달 항목에 사용
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

CLI 템플릿은 또한 다음을 사용할 수 있습니다:

- `{{MediaDir}}` (미디어 파일이 포함된 디렉터리)
- `{{OutputDir}}` (이 실행을 위해 생성된 임시 디렉터리)
- `{{OutputBase}}` (확장자 없는 임시 파일 기본 경로)

## 기본값과 제한

추천 기본값:

- `maxChars`: 이미지/비디오용 **500** (짧고 명령어 친화적임)
- `maxChars`: 오디오용 **미설정** (전체 전사문, 단 제한을 설정한 경우 제외)
- `maxBytes`:
  - 이미지: **10MB**
  - 오디오: **20MB**
  - 비디오: **50MB**

규칙:

- 미디어가 `maxBytes`를 초과하면 그 모델은 건너뛰어지고 **다음 모델이 시도**됩니다.
- 모델이 `maxChars`보다 많은 결과를 반환하면 출력이 잘립니다.
- `prompt`는 기본적으로 간단한 “{media}를 설명하세요.”에 `maxChars` 지침이 추가됩니다 (이미지/비디오만 해당).
- `<capability>.enabled: true`로 설정되어 있지만 구성된 모델이 없는 경우, OpenClaw는 해당 프로바이더가 지원하는 기능을 가진 **활성 응답 모델**을 시도합니다.

### 미디어 이해 자동 감지 (기본값)

`tools.media.<capability>.enabled`가 **false**로 설정되지 않고 모델을 구성하지 않은 경우, OpenClaw는 다음 순서로 자동 감지하며 **첫 번째 작동 옵션에서 정지**합니다:

1. **로컬 CLIs** (오디오 전용; 설치된 경우)
   - `sherpa-onnx-offline` (인코더/디코더/조이너/토큰이 있는 `SHERPA_ONNX_MODEL_DIR` 필요)
   - `whisper-cli` (`whisper-cpp`; `WHISPER_CPP_MODEL` 또는 번들 작은 모델 사용)
   - `whisper` (Python CLI; 모델 자동 다운로드)
2. **Gemini CLI** (`gemini`) 사용하여 `read_many_files`
3. **프로바이더 키**
   - 오디오: OpenAI → Groq → Deepgram → Google
   - 이미지: OpenAI → Anthropic → Google → MiniMax
   - 비디오: Google

자동 감지를 비활성화하려면, 다음과 같이 설정합니다:

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

참고: 바이너리 감지는 macOS/Linux/Windows에서 최선의 노력을 다하므로 CLI가 `PATH`에 있는지 확인하세요 (`~`를 확장합니다), 또는 전체 명령어 경로로 명시적인 CLI 모델을 설정하세요.

## 기능 (선택 사항)

`capabilities`를 설정하면 해당 미디어 유형에 대해서만 항목이 실행됩니다. 공유 목록의 경우, OpenClaw는 기본값을 추론할 수 있습니다:

- `openai`, `anthropic`, `minimax`: **이미지**
- `google` (Gemini API): **이미지 + 오디오 + 비디오**
- `groq`: **오디오**
- `deepgram`: **오디오**

CLI 항목의 경우, **`capabilities`를 명시적으로 설정**하여 놀라운 일치를 피하세요. `capabilities`를 생략하면 항목이 나타나는 목록에 대해 자격을 갖추게 됩니다.

## 프로바이더 지원 매트릭스 (OpenClaw 통합)

| 기능      | 프로바이더 통합                                 | 참고 사항                                         |
| --------- | ---------------------------------------------- | ------------------------------------------------- |
| 이미지    | OpenAI / Anthropic / Google / others via `pi-ai` | 레지스트리의 모든 이미지 지원 모델이 작동합니다.    |
| 오디오    | OpenAI, Groq, Deepgram, Google                 | 프로바이더 전사 (Whisper/Deepgram/Gemini).        |
| 비디오    | Google (Gemini API)                            | 프로바이더 비디오 이해.                           |

## 추천 프로바이더

**이미지**

- 이미지 지원이 가능한 경우 활성 모델을 선호합니다.
- 좋은 기본값: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**오디오**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo`, 또는 `deepgram/nova-3`.
- CLI 폴백: `whisper-cli` (whisper-cpp) 또는 `whisper`.
- Deepgram 설정: [Deepgram (오디오 전사)](/ko-KR/providers/deepgram).

**비디오**

- `google/gemini-3-flash-preview` (빠름), `google/gemini-3-pro-preview` (풍부함).
- CLI 폴백: `gemini` CLI (비디오/오디오에 `read_file` 지원).

## 첨부 파일 정책

기능별 `attachments`는 처리할 첨부 파일을 제어합니다:

- `mode`: `first` (기본값) 또는 `all`
- `maxAttachments`: 처리할 개수 상한 (기본값 **1**)
- `prefer`: `first`, `last`, `path`, `url`

`mode: "all"`일 때, 출력은 `[Image 1/2]`, `[Audio 2/2]` 등으로 레이블이 지정됩니다.

## 설정 예시

### 1) 공유 모델 목록과 재정의

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

### 2) 오디오 + 비디오 전용 (이미지 비활성화)

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

### 4) 다중 모달 단일 항목 (명시적 기능)

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

미디어 이해가 실행될 때, `/status`에는 짧은 요약 줄이 포함됩니다:

```
📎 Media: image ok (openai/gpt-5.2) · audio skipped (maxBytes)
```

이는 기능별 결과와 해당하는 경우 선택된 프로바이더/모델을 나타냅니다.

## 참고 사항

- 이해는 **최선의 노력**입니다. 오류는 응답을 차단하지 않습니다.
- 첨부 파일은 이해가 비활성화된 경우에도 여전히 모델에 전달됩니다.
- `scope`를 사용하여 이해가 실행되는 위치를 제한하세요 (예: 다이렉트 메시지에만).

## 관련 문서

- [설정](/ko-KR/gateway/configuration)
- [이미지 & 미디어 지원](/ko-KR/nodes/images)