---
summary: "Deepgram transcription for inbound voice notes"
read_when:
  - You want Deepgram speech-to-text for audio attachments
  - You need a quick Deepgram config example
title: "Deepgram"
x-i18n:
  source_hash: dabd1f6942c339fbd744fbf38040b6a663b06ddf4d9c9ee31e3ac034de9e79d9
---

# 딥그램(오디오 전사)

Deepgram은 음성을 텍스트로 변환하는 API입니다. OpenClaw에서는 **인바운드 오디오/음성 메모에 사용됩니다.
`tools.media.audio`를 통한 전사**.

활성화되면 OpenClaw는 오디오 파일을 Deepgram에 업로드하고 녹취록을 삽입합니다.
응답 파이프라인(`{{Transcript}}` + `[Audio]` 블록)에 추가합니다. **스트리밍이 아닙니다**;
사전 녹음된 전사 엔드포인트를 사용합니다.

홈페이지: [https://deepgram.com](https://deepgram.com)  
문서: [https://developers.deepgram.com](https://developers.deepgram.com)

## 빠른 시작

1. API 키를 설정합니다.

```
DEEPGRAM_API_KEY=dg_...
```

2. 공급자를 활성화합니다.

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## 옵션

- `model`: 딥그램 모델 ID (기본값: `nova-3`)
- `language`: 언어 힌트 (선택)
- `tools.media.audio.providerOptions.deepgram.detect_language`: 언어 감지 활성화(선택 사항)
- `tools.media.audio.providerOptions.deepgram.punctuate`: 구두점 활성화(선택 사항)
- `tools.media.audio.providerOptions.deepgram.smart_format`: 스마트 서식 활성화(선택 사항)

언어의 예:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

Deepgram 옵션의 예:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## 메모

- 인증은 표준 공급자 인증 순서를 따릅니다. `DEEPGRAM_API_KEY`는 가장 간단한 경로입니다.
- 프록시를 사용할 때 `tools.media.audio.baseUrl` 및 `tools.media.audio.headers`를 사용하여 엔드포인트 또는 헤더를 재정의합니다.
- 출력은 다른 공급자와 동일한 오디오 규칙(크기 제한, 시간 제한, 성적표 삽입)을 따릅니다.
