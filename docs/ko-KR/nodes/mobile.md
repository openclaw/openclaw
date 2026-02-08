---
summary: "iOS 및 Android 노드 앱 설정"
read_when:
  - 모바일 노드를 설정할 때
title: "모바일 노드"
---

# 모바일 노드

iOS 및 Android에서 OpenClaw 노드 앱을 설정하는 가이드입니다.

## 노드란?

노드는 모바일 기기에서 실행되는 OpenClaw 클라이언트입니다:

- Gateway와 연결
- 에이전트와 직접 대화
- Canvas, 음성, 카메라 등 모바일 기능 제공

## iOS 노드

### 설치

1. App Store에서 "OpenClaw" 검색
2. 앱 설치

### 페어링

1. Gateway 실행 확인
2. 앱 열기
3. "Gateway 연결" 탭
4. QR 코드 스캔 또는 URL 입력

### QR 코드

```bash
# QR 코드 표시
openclaw nodes pair

# 또는 Control UI에서
# Nodes 탭 → "새 노드 페어링"
```

## Android 노드

### 설치

1. Google Play에서 "OpenClaw" 검색
2. 앱 설치

### 페어링

iOS와 동일한 방식

### 권한

Android에서 필요한 권한:

- **마이크**: 음성 입력
- **카메라**: 사진/스캔
- **위치**: 위치 공유
- **알림**: 푸시 알림
- **화면 오버레이**: Canvas

## 기능

### Chat

에이전트와 직접 대화:

- 텍스트 메시지
- 음성 메시지
- 이미지/파일 첨부

### Canvas

화면 공유:

- 에이전트에게 화면 보여주기
- 터치 제어 허용

### Voice

음성 대화:

- Voice wake (웨이크 워드)
- Talk 모드 (연속 대화)
- TTS 응답

### Camera

카메라 기능:

- 사진 촬영 및 분석
- QR 코드 스캔
- 실시간 분석

### Location

위치 공유:

- 현재 위치 공유
- 위치 기반 요청

## 설정

### Gateway 연결

```json5
{
  nodes: {
    enabled: true,
    autoConnect: true,
  },
}
```

### 노드별 설정

```json5
{
  nodes: {
    devices: {
      "device-id": {
        name: "내 iPhone",
        agent: "main",
        features: {
          canvas: true,
          voice: true,
          camera: true,
        },
      },
    },
  },
}
```

## 보안

### 페어링 승인

```json5
{
  nodes: {
    pairing: {
      requireApproval: true,
      timeout: 300, // 초
    },
  },
}
```

### 기능 제한

```json5
{
  nodes: {
    devices: {
      "device-id": {
        features: {
          canvas: false, // Canvas 비활성화
        },
      },
    },
  },
}
```

## 알림

### 푸시 알림

```json5
{
  nodes: {
    notifications: {
      push: true,
      sound: true,
      badge: true,
    },
  },
}
```

### 알림 필터

```json5
{
  nodes: {
    notifications: {
      filter: {
        mentions: true,
        dm: true,
        group: false,
      },
    },
  },
}
```

## 오프라인 모드

네트워크 없이도 일부 기능 사용:

- 로컬 메모/캐시
- 오프라인 큐

```json5
{
  nodes: {
    offline: {
      enabled: true,
      cacheSize: "100mb",
    },
  },
}
```

## 문제 해결

### 연결 안 됨

1. Gateway가 실행 중인지 확인
2. 같은 네트워크인지 확인
3. 방화벽 설정 확인
4. 페어링 재시도

### 페어링 실패

1. QR 코드 재생성
2. URL 수동 입력
3. Tailscale 사용 (원격)

### 기능 작동 안 함

1. 앱 권한 확인
2. Gateway 설정 확인
3. 앱 업데이트 확인

## 노드 관리

### 목록 확인

```bash
openclaw nodes list
```

### 노드 제거

```bash
openclaw nodes remove <device-id>
```

### 모든 노드 연결 해제

```bash
openclaw nodes unpair --all
```
