---
summary: "iOS/Android 노드, 음성, 카메라, 미디어 기능"
read_when:
  - 모바일 노드 사용 시
  - 음성/미디어 기능 설정 시
title: "노드 및 미디어"
---

# 노드 및 미디어

OpenClaw는 iOS/Android 앱을 통해 모바일 기능을 확장합니다.

## 모바일 노드

노드는 모바일 기기에서 실행되는 OpenClaw 앱입니다.

### 노드 기능

| 기능         | 설명                   |
| ------------ | ---------------------- |
| **Canvas**   | 화면 공유 및 원격 제어 |
| **Camera**   | 카메라 접근            |
| **Location** | 위치 정보              |
| **Push**     | 푸시 알림              |
| **Voice**    | 음성 입력/출력         |

### 노드 페어링

1. 모바일 앱을 설치합니다
2. Gateway의 Control UI에서 "Nodes" 탭 열기
3. QR 코드 스캔 또는 페어링 코드 입력

```bash
# 노드 목록
openclaw nodes list

# 노드 페어링 해제
openclaw nodes unpair <node-id>
```

### 노드 설정

```json5
{
  nodes: {
    enabled: true,
    autoAccept: false, // 자동 페어링 승인
    allowedCapabilities: ["camera", "location", "canvas"],
  },
}
```

## Canvas

Canvas는 모바일 화면을 에이전트와 공유하는 기능입니다.

### Canvas 사용

1. 모바일 앱에서 Canvas 시작
2. 에이전트가 화면을 보고 지시 가능
3. 필요시 터치 액션 수행

### Canvas 설정

```json5
{
  canvas: {
    enabled: true,
    quality: "medium", // low | medium | high
    frameRate: 10,
  },
}
```

## 음성 (Voice)

음성 입력 및 출력 기능입니다.

### Talk Mode

대화형 음성 모드:

- 음성으로 질문
- 음성으로 응답 받기
- 핸즈프리 대화

### Voice Wake

웨이크 워드로 음성 활성화:

```json5
{
  voicewake: {
    enabled: true,
    wakeWord: "hey openclaw",
    sensitivity: 0.5,
  },
}
```

### TTS (Text-to-Speech)

응답을 음성으로 변환:

```json5
{
  tts: {
    enabled: true,
    provider: "system", // system | elevenlabs | openai
    voice: "default",
  },
}
```

### STT (Speech-to-Text)

음성을 텍스트로 변환:

```json5
{
  stt: {
    enabled: true,
    provider: "whisper",
    language: "ko",
  },
}
```

## 카메라

모바일 카메라를 통한 이미지 캡처.

### 카메라 명령어

채팅에서:

```
/camera capture     # 사진 촬영
/camera front       # 전면 카메라
/camera back        # 후면 카메라
```

### 카메라 설정

```json5
{
  camera: {
    defaultFacing: "back",
    resolution: "medium",
    autoFocus: true,
  },
}
```

## 위치

위치 정보 접근.

### 위치 명령어

```
/location           # 현재 위치
/location share     # 위치 공유
```

### 위치 설정

```json5
{
  location: {
    enabled: true,
    accuracy: "high",
    updateInterval: 60, // 초
  },
}
```

## 미디어 이해

에이전트가 이미지, 오디오, 문서를 이해합니다.

### 이미지 분석

이미지를 첨부하면 에이전트가:

- 내용 설명
- 텍스트 인식 (OCR)
- 객체 감지
- 코드 스크린샷 분석

### 오디오 분석

오디오 파일을 첨부하면:

- 음성을 텍스트로 변환
- 내용 요약
- 언어 감지

### 문서 분석

PDF, 문서 파일:

- 텍스트 추출
- 내용 요약
- 질문 답변

## 미디어 제한

### 크기 제한

```json5
{
  agents: {
    defaults: {
      mediaMaxMb: 5, // 아웃바운드
    },
  },
  channels: {
    whatsapp: {
      mediaMaxMb: 50, // 인바운드
    },
  },
}
```

### 지원 형식

| 유형   | 형식                 |
| ------ | -------------------- |
| 이미지 | JPEG, PNG, WebP, GIF |
| 오디오 | MP3, OGG, M4A, WAV   |
| 비디오 | MP4, WebM            |
| 문서   | PDF, TXT, MD         |

## 문제 해결

### 노드가 연결되지 않음

1. 같은 네트워크에 있는지 확인
2. Gateway 포트가 열려 있는지 확인
3. 노드 앱 재시작

### 카메라가 작동하지 않음

1. 앱에 카메라 권한 허용
2. 다른 앱이 카메라 사용 중인지 확인

### 음성 인식이 안 됨

1. 마이크 권한 확인
2. 언어 설정 확인
3. 네트워크 연결 확인
