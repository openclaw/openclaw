---
read_when:
    - 채널 위치 구문 분석 추가 또는 수정
    - 상담원 프롬프트 또는 도구에서 위치 컨텍스트 필드 사용
summary: 인바운드 채널 위치 분석(Telegram + WhatsApp) 및 컨텍스트 필드
title: 채널 위치 분석
x-i18n:
    generated_at: "2026-02-08T15:47:46Z"
    model: gtx
    provider: google-translate
    source_hash: 5602ef105c3da7e47497bfed8fc343dd8d7f3c019ff7e423a08b25092c5a1837
    source_path: channels/location.md
    workflow: 15
---

# 채널 위치 분석

OpenClaw는 채팅 채널의 공유 위치를 다음과 같이 정규화합니다.

- 인바운드 본문에 사람이 읽을 수 있는 텍스트가 추가됩니다.
- 자동 응답 컨텍스트 페이로드의 구조화된 필드.

현재 지원되는 것:

- **전보** (위치 핀 + 장소 + 라이브 위치)
- **왓츠앱** (locationMessage + liveLocationMessage)
- **행렬** (`m.location` ~와 함께 `geo_uri`)

## 텍스트 서식

위치는 대괄호 없이 친숙한 선으로 렌더링됩니다.

- 핀:
  - `📍 48.858844, 2.294351 ±12m`
- 지명된 장소:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- 실시간 공유:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

채널에 캡션/댓글이 포함되어 있으면 다음 줄에 추가됩니다.

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## 컨텍스트 필드

위치가 있으면 이 필드가 다음에 추가됩니다. `ctx`:

- `LocationLat` (숫자)
- `LocationLon` (숫자)
- `LocationAccuracy` (숫자, 미터; 선택 사항)
- `LocationName` (문자열; 선택사항)
- `LocationAddress` (문자열; 선택사항)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (부울)

## 채널 노트

- **전보**: 장소 지도 `LocationName/LocationAddress`; 실시간 위치 사용 `live_period`.
- **왓츠앱**:`locationMessage.comment` 그리고 `liveLocationMessage.caption` 캡션 줄로 추가됩니다.
- **행렬**:`geo_uri` 핀 위치로 구문 분석됩니다. 고도는 무시되고 `LocationIsLive` 항상 거짓입니다.
