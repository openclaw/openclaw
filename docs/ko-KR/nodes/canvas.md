---
summary: "Canvas 화면 공유 기능"
read_when:
  - Canvas를 사용할 때
title: "Canvas"
---

# Canvas

Canvas는 모바일 화면을 에이전트와 공유하는 기능입니다.

## Canvas란?

Canvas를 사용하면 에이전트가:

- 모바일 화면을 실시간으로 볼 수 있음
- 화면 내용을 분석하고 도움 제공
- 터치 액션을 수행할 수 있음

## 요구사항

- iOS 또는 Android 노드 앱
- Gateway와 노드가 같은 네트워크
- 노드 페어링 완료

## Canvas 시작

### 노드 앱에서

1. 노드 앱 열기
2. Canvas 탭 선택
3. "공유 시작" 버튼 탭
4. 화면 공유 권한 허용

### 채팅에서

```
/canvas start
/canvas stop
```

## 설정

### 기본 설정

```json5
{
  canvas: {
    enabled: true,
    quality: "medium",
    frameRate: 10,
  },
}
```

### 품질 옵션

| 품질     | 해상도 | 프레임레이트 | 대역폭   |
| -------- | ------ | ------------ | -------- |
| `low`    | 480p   | 5fps         | ~100KB/s |
| `medium` | 720p   | 10fps        | ~300KB/s |
| `high`   | 1080p  | 15fps        | ~800KB/s |

### 프레임레이트

```json5
{
  canvas: {
    frameRate: 15, // 1-30
  },
}
```

## 상호작용

### 터치 액션

에이전트가 사용할 수 있는 액션:

| 액션        | 설명        |
| ----------- | ----------- |
| `tap`       | 탭          |
| `doubleTap` | 더블 탭     |
| `longPress` | 길게 누르기 |
| `swipe`     | 스와이프    |
| `type`      | 텍스트 입력 |

### 액션 승인

```json5
{
  canvas: {
    actions: {
      requireApproval: true, // 모든 액션에 승인 필요
    },
  },
}
```

### 자동 승인

```json5
{
  canvas: {
    actions: {
      autoApprove: ["tap", "swipe"],
      requireApproval: ["type", "longPress"],
    },
  },
}
```

## 스크린샷

### 수동 캡처

채팅에서:

```
/canvas screenshot
```

### 자동 캡처

```json5
{
  canvas: {
    screenshot: {
      onRequest: true,
      quality: 80, // JPEG 품질
    },
  },
}
```

## 보안

### 민감 영역 마스킹

```json5
{
  canvas: {
    privacy: {
      maskKeyboard: true,
      maskNotifications: true,
    },
  },
}
```

### 자동 중지

```json5
{
  canvas: {
    autoStop: {
      onLock: true,
      onInactivity: 300, // 초
    },
  },
}
```

## 사용 사례

### 앱 도움

1. Canvas 시작
2. "이 앱 어떻게 사용해?"
3. 에이전트가 화면을 보고 안내

### 디버깅

1. 문제 화면에서 Canvas 시작
2. "이 오류 어떻게 해결해?"
3. 에이전트가 분석 및 해결 제안

### 자동화

1. Canvas 시작
2. "이 작업을 반복해줘"
3. 에이전트가 터치 액션 수행

## 문제 해결

### 화면이 보이지 않음

1. 화면 공유 권한 확인
2. 노드 연결 상태 확인
3. 네트워크 연결 확인

### 지연이 심함

1. 품질 설정 낮추기
2. 프레임레이트 낮추기
3. 네트워크 대역폭 확인

### 터치가 작동하지 않음

1. 접근성 권한 확인 (Android)
2. 액션 승인 설정 확인
