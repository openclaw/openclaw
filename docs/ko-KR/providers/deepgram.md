```markdown
---
summary: "들어오는 음성 메모에 대한 Deepgram 필기 기록"
read_when:
  - 오디오 첨부 파일에 대한 Deepgram 음성 인식을 원함
  - 간단한 Deepgram 설정 예제가 필요함
title: "Deepgram"
---

# Deepgram (오디오 필기 기록)

Deepgram은 음성 인식 API입니다. OpenClaw에서는 `tools.media.audio`를 통해 **들어오는 오디오/음성 메모 필기 기록**에 사용됩니다.

활성화되면, OpenClaw는 오디오 파일을 Deepgram에 업로드하고 필기록을 응답 파이프라인 (`{{Transcript}}` + `[Audio]` 블록)에 삽입합니다. 이는 **스트리밍이 아닙니다**. 미리 녹음된 필기 기록 엔드포인트를 사용합니다.

웹사이트: [https://deepgram.com](https://deepgram.com)  
문서: [https://developers.deepgram.com](https://developers.deepgram.com)

## 시작하기

1. API 키 설정:
```

DEEPGRAM*API_KEY=dg*...

````

2. 프로바이더 활성화:

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
````

## 옵션

- `model`: Deepgram 모델 ID (기본값: `nova-3`)
- `language`: 언어 힌트 (선택 사항)
- `tools.media.audio.providerOptions.deepgram.detect_language`: 언어 감지 활성화 (선택 사항)
- `tools.media.audio.providerOptions.deepgram.punctuate`: 구두점 활성화 (선택 사항)
- `tools.media.audio.providerOptions.deepgram.smart_format`: 스마트 형식 활성화 (선택 사항)

언어 사용 예제:

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

Deepgram 옵션 사용 예제:

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

## 주의사항

- 인증은 표준 프로바이더 인증 순서를 따릅니다. `DEEPGRAM_API_KEY`가 가장 간단한 경로입니다.
- 프록시를 사용할 때 `tools.media.audio.baseUrl`과 `tools.media.audio.headers`로 엔드포인트나 헤더를 재정의하세요.
- 출력은 다른 프로바이더와 동일한 오디오 규칙을 따릅니다 (크기 제한, 타임아웃, 필기 기록 삽입).

```

```
