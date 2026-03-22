---
summary: "인바운드 채널 위치 파싱 (Telegram + WhatsApp) 및 컨텍스트 필드"
read_when:
  - 채널 위치 파싱을 추가하거나 수정하는 경우
  - 에이전트 프롬프트 또는 도구에서 위치 컨텍스트 필드를 사용하는 경우
title: "채널 위치 파싱"
x-i18n:
  source_path: docs/channels/location.md
---

# 채널 위치 파싱

OpenClaw 는 채팅 채널에서 공유된 위치를 다음과 같이 정규화합니다:

- 인바운드 본문에 추가되는 사람이 읽을 수 있는 텍스트
- 자동 응답 컨텍스트 페이로드의 구조화된 필드

현재 지원:

- **Telegram** (위치 핀 + 장소 + 실시간 위치)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`geo_uri` 가 포함된 `m.location`)

## 텍스트 형식

위치는 괄호 없이 친숙한 줄로 렌더링됩니다:

- 핀:
  - `📍 48.858844, 2.294351 ±12m`
- 명명된 장소:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- 실시간 공유:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

채널에 캡션/코멘트가 포함된 경우 다음 줄에 추가됩니다:

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## 컨텍스트 필드

위치가 있는 경우 다음 필드가 `ctx` 에 추가됩니다:

- `LocationLat` (숫자)
- `LocationLon` (숫자)
- `LocationAccuracy` (숫자, 미터; 선택 사항)
- `LocationName` (문자열; 선택 사항)
- `LocationAddress` (문자열; 선택 사항)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (불리언)

## 채널 참고 사항

- **Telegram**: 장소는 `LocationName/LocationAddress` 에 매핑됩니다. 실시간 위치는 `live_period` 를 사용합니다.
- **WhatsApp**: `locationMessage.comment` 과 `liveLocationMessage.caption` 이 캡션 줄로 추가됩니다.
- **Matrix**: `geo_uri` 가 핀 위치로 파싱됩니다. 고도는 무시되며 `LocationIsLive` 는 항상 false 입니다.
