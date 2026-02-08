---
summary: "카메라 및 이미지 분석"
read_when:
  - 카메라 기능을 사용할 때
title: "카메라"
---

# 카메라

카메라를 통한 이미지 캡처 및 분석 기능입니다.

## 기능

- 사진 촬영 및 에이전트 분석
- QR/바코드 스캔
- 문서 스캔
- 실시간 분석 (노드 앱)

## 카메라 사용

### 노드 앱에서

1. 카메라 탭 선택
2. 사진 촬영 또는 갤러리에서 선택
3. 에이전트가 자동 분석

### 채팅에서

이미지를 직접 첨부하면 Vision 모델로 분석:

```
[이미지 첨부]
"이 이미지에 무엇이 있어?"
```

## 설정

### 기본 설정

```json5
{
  camera: {
    enabled: true,
    quality: "high",
    analyze: true,
  },
}
```

### Vision 모델

이미지 분석에 사용되는 모델:

```json5
{
  agents: {
    defaults: {
      vision: {
        model: "anthropic/claude-opus-4-6", // Vision 지원 모델
      },
    },
  },
}
```

## 이미지 분석

### 자동 분석

```json5
{
  media: {
    images: {
      autoAnalyze: true,
      prompt: "이 이미지를 분석해줘",
    },
  },
}
```

### 분석 유형

에이전트에게 특정 분석 요청:

```
[이미지 첨부]
"이 영수증의 항목들을 표로 정리해줘"
```

```
[이미지 첨부]
"이 코드의 버그를 찾아줘"
```

## QR/바코드 스캔

### 스캔 기능

노드 앱에서 QR 코드 스캔:

- URL 열기
- 텍스트 추출
- 연락처 추가

### 자동 처리

```json5
{
  camera: {
    qr: {
      autoOpen: false, // URL 자동 열기
      notify: true, // 스캔 결과 알림
    },
  },
}
```

## 문서 스캔

### OCR

```json5
{
  camera: {
    ocr: {
      enabled: true,
      languages: ["ko", "en"],
    },
  },
}
```

### 문서 처리

```
[문서 사진 첨부]
"이 문서의 내용을 텍스트로 추출해줘"
```

## 이미지 저장

```json5
{
  media: {
    images: {
      save: true,
      path: "~/.openclaw/media/images",
      retention: "30d",
    },
  },
}
```

## 프라이버시

### 자동 삭제

```json5
{
  media: {
    images: {
      autoDelete: true,
      deleteAfter: 3600, // 초
    },
  },
}
```

### 민감 정보 마스킹

```json5
{
  camera: {
    privacy: {
      detectFaces: true,
      blur: true,
    },
  },
}
```

## 제한

### 파일 크기

```json5
{
  media: {
    images: {
      maxSize: "10mb",
      resize: {
        maxWidth: 2048,
        maxHeight: 2048,
      },
    },
  },
}
```

## 문제 해결

### 분석 실패

1. Vision 모델 지원 확인
2. 이미지 크기 확인
3. 이미지 형식 확인 (JPEG, PNG, GIF, WebP)

### 카메라 접근 안 됨

1. 앱 권한 확인
2. 카메라 사용 중인 다른 앱 확인
