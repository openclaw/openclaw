---
summary: "미디어 파일 처리 및 형식"
read_when:
  - 미디어 파일을 처리할 때
title: "미디어"
---

# 미디어

이미지, 오디오, 비디오, 문서 처리 가이드입니다.

## 지원 형식

### 이미지

| 형식 | 수신 | 전송 | 분석 |
| ---- | ---- | ---- | ---- |
| JPEG | ✅   | ✅   | ✅   |
| PNG  | ✅   | ✅   | ✅   |
| GIF  | ✅   | ✅   | ✅   |
| WebP | ✅   | ✅   | ✅   |
| HEIC | ✅   | ❌   | ✅   |

### 오디오

| 형식 | 수신 | 전송 | 변환 |
| ---- | ---- | ---- | ---- |
| MP3  | ✅   | ✅   | ✅   |
| OGG  | ✅   | ✅   | ✅   |
| WAV  | ✅   | ✅   | ✅   |
| M4A  | ✅   | ❌   | ✅   |

### 비디오

| 형식 | 수신 | 분석        |
| ---- | ---- | ----------- |
| MP4  | ✅   | 프레임 추출 |
| WebM | ✅   | 프레임 추출 |

### 문서

| 형식 | 수신 | 텍스트 추출 |
| ---- | ---- | ----------- |
| PDF  | ✅   | ✅          |
| DOCX | ✅   | ✅          |
| TXT  | ✅   | ✅          |
| MD   | ✅   | ✅          |

## 설정

### 기본 설정

```json5
{
  media: {
    images: {
      maxSize: "10mb",
      analyze: true,
    },
    audio: {
      maxSize: "25mb",
      transcribe: true,
    },
    documents: {
      maxSize: "50mb",
      extract: true,
    },
  },
}
```

### 채널별 제한

```json5
{
  channels: {
    telegram: {
      mediaMaxMb: 50,
    },
    whatsapp: {
      mediaMaxMb: 16,
    },
  },
}
```

## 이미지 분석

### Vision 모델

```json5
{
  agents: {
    defaults: {
      vision: {
        enabled: true,
        model: "anthropic/claude-opus-4-6",
      },
    },
  },
}
```

### 자동 분석

이미지 첨부 시 자동 분석:

```json5
{
  media: {
    images: {
      autoAnalyze: true,
      analyzePrompt: "이 이미지를 분석해줘",
    },
  },
}
```

## 음성 변환

### STT 설정

```json5
{
  stt: {
    enabled: true,
    provider: "whisper",
    language: "ko",
  },
}
```

### 자동 변환

음성 메시지 자동 텍스트 변환:

```json5
{
  media: {
    audio: {
      autoTranscribe: true,
    },
  },
}
```

## 문서 추출

### OCR

```json5
{
  media: {
    documents: {
      ocr: {
        enabled: true,
        languages: ["ko", "en"],
      },
    },
  },
}
```

## 저장소

### 저장 위치

```
~/.openclaw/media/
├── images/
├── audio/
├── video/
└── documents/
```

### 보관 기간

```json5
{
  media: {
    storage: {
      path: "~/.openclaw/media",
      retention: "30d",
      maxSize: "1gb",
    },
  },
}
```

## 미디어 전송

### 이미지 전송

에이전트가 이미지 생성:

```
[[image:path/to/image.png]]
```

### 파일 전송

```
[[file:path/to/document.pdf]]
```

## 프라이버시

### 자동 삭제

```json5
{
  media: {
    privacy: {
      deleteAfterProcess: true,
    },
  },
}
```

### 메타데이터 제거

```json5
{
  media: {
    privacy: {
      stripMetadata: true,
    },
  },
}
```

## 문제 해결

### 이미지 분석 실패

1. Vision 지원 모델 확인
2. 이미지 크기 확인
3. 형식 지원 확인

### 음성 변환 실패

1. STT 설정 확인
2. 오디오 형식 확인
3. API 키 확인
