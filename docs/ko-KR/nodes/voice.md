---
summary: "음성 입출력, TTS, STT 설정"
read_when:
  - 음성 기능을 사용할 때
title: "음성"
---

# 음성

OpenClaw의 음성 입출력 기능입니다.

## 음성 입력 (STT)

### 지원 채널

| 채널     | 음성 메시지           |
| -------- | --------------------- |
| Telegram | ✅ 음성 메시지        |
| WhatsApp | ✅ 음성 메시지        |
| Discord  | ✅ 음성 채널 (제한적) |
| Node     | ✅ 마이크             |

### STT 설정

```json5
{
  stt: {
    enabled: true,
    provider: "whisper", // whisper | google | azure
    language: "ko",
  },
}
```

### Whisper 설정

```json5
{
  stt: {
    provider: "whisper",
    whisper: {
      model: "whisper-1", // OpenAI Whisper
    },
  },
}
```

### 로컬 Whisper

```json5
{
  stt: {
    provider: "whisper-local",
    whisperLocal: {
      model: "medium",
      device: "cpu", // cpu | cuda
    },
  },
}
```

## 음성 출력 (TTS)

### TTS 설정

```json5
{
  tts: {
    enabled: true,
    provider: "system", // system | elevenlabs | openai | azure
  },
}
```

### ElevenLabs

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      apiKey: "your_api_key",
      voiceId: "voice_id",
      model: "eleven_multilingual_v2",
    },
  },
}
```

### OpenAI TTS

```json5
{
  tts: {
    provider: "openai",
    openai: {
      model: "tts-1",
      voice: "alloy", // alloy | echo | fable | onyx | nova | shimmer
    },
  },
}
```

### 시스템 TTS

```json5
{
  tts: {
    provider: "system",
    system: {
      voice: "default",
      rate: 1.0,
      pitch: 1.0,
    },
  },
}
```

## Talk Mode

대화형 음성 모드입니다.

### 활성화

Node 앱에서:

1. Talk 버튼 탭
2. 음성으로 말하기
3. 음성 응답 받기

### 설정

```json5
{
  talk: {
    enabled: true,
    autoListen: true, // 응답 후 자동으로 듣기 시작
    silenceThreshold: 1.5, // 초
  },
}
```

## Voice Wake

웨이크 워드로 음성 활성화:

### 설정

```json5
{
  voicewake: {
    enabled: true,
    wakeWord: "hey openclaw",
    sensitivity: 0.5,
    timeout: 30, // 초
  },
}
```

### 커스텀 웨이크 워드

```json5
{
  voicewake: {
    wakeWord: "안녕 클로",
    language: "ko",
  },
}
```

## 채널별 음성 설정

### Telegram

```json5
{
  channels: {
    telegram: {
      voice: {
        autoTranscribe: true,
        replyWithVoice: false,
      },
    },
  },
}
```

### WhatsApp

```json5
{
  channels: {
    whatsapp: {
      voice: {
        autoTranscribe: true,
        maxDuration: 120, // 초
      },
    },
  },
}
```

## 오디오 형식

### 지원 형식

| 형식     | 입력 | 출력 |
| -------- | ---- | ---- |
| OGG/Opus | ✅   | ✅   |
| MP3      | ✅   | ✅   |
| WAV      | ✅   | ✅   |
| M4A      | ✅   | -    |
| WebM     | ✅   | -    |

### 출력 형식 설정

```json5
{
  tts: {
    outputFormat: "mp3",
    sampleRate: 24000,
  },
}
```

## 언어 설정

### 자동 감지

```json5
{
  stt: {
    language: "auto",
  },
}
```

### 특정 언어

```json5
{
  stt: {
    language: "ko", // 한국어
  },
}
```

### 다국어

```json5
{
  stt: {
    languages: ["ko", "en", "ja"],
  },
}
```

## 품질 설정

### STT 품질

```json5
{
  stt: {
    quality: {
      model: "large", // tiny | base | small | medium | large
      beam: 5,
    },
  },
}
```

### TTS 품질

```json5
{
  tts: {
    quality: {
      sampleRate: 48000,
      bitrate: 192,
    },
  },
}
```

## 문제 해결

### 음성 인식이 안 됨

1. 마이크 권한 확인
2. 오디오 형식 지원 확인
3. API 키 확인 (외부 서비스 사용 시)

### 음성 출력이 안 됨

1. 스피커/오디오 출력 확인
2. TTS 설정 확인
3. 음성 파일 생성 확인

### 품질이 낮음

1. 더 큰 모델 사용
2. 샘플레이트 증가
3. 네트워크 연결 확인
