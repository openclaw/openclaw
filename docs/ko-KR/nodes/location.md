---
summary: "위치 공유 및 지오펜스"
read_when:
  - 위치 기능을 사용할 때
title: "위치"
---

# 위치

위치 공유 및 위치 기반 기능입니다.

## 기능

- 현재 위치 공유
- 위치 기반 요청
- 지오펜스 알림

## 위치 공유

### 노드 앱에서

1. 위치 탭 선택
2. "현재 위치 공유" 탭
3. 에이전트가 위치 인식

### 채팅에서

위치 메시지 전송 (지원 채널):

- Telegram
- WhatsApp
- iMessage

## 위치 기반 요청

```
[위치 공유]
"근처에 좋은 점심 식당 추천해줘"
```

```
[위치 공유]
"여기서 가장 가까운 지하철역은?"
```

## 설정

### 기본 설정

```json5
{
  location: {
    enabled: true,
    shareWithAgent: true,
  },
}
```

### 프라이버시

```json5
{
  location: {
    privacy: {
      precision: "city", // exact | street | city | none
      expiresAfter: 3600, // 초
    },
  },
}
```

## 지오펜스

특정 위치 진입/퇴장 시 알림:

```json5
{
  location: {
    geofences: [
      {
        id: "home",
        center: { lat: 37.5665, lng: 126.978 },
        radius: 100, // 미터
        onEnter: {
          prompt: "집에 도착했어. 해야 할 일 있어?",
        },
        onExit: {
          prompt: "외출했어. 체크해야 할 것 있어?",
        },
      },
    ],
  },
}
```

## 권한

### iOS

위치 권한 요청:

- "앱 사용 중" - 기본
- "항상" - 지오펜스용

### Android

권한 유형:

- `ACCESS_FINE_LOCATION` - 정확한 위치
- `ACCESS_BACKGROUND_LOCATION` - 백그라운드 위치

## 문제 해결

### 위치 부정확

1. GPS 활성화 확인
2. 위치 권한 확인
3. 실내에서는 정확도 낮을 수 있음

### 지오펜스 작동 안 함

1. 백그라운드 위치 권한 확인
2. 배터리 최적화에서 앱 제외
