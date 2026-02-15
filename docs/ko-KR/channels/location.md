---
summary: "Inbound channel location parsing (Telegram + WhatsApp) and context fields"
read_when:
  - Adding or modifying channel location parsing
  - Using location context fields in agent prompts or tools
title: "Channel Location Parsing"
x-i18n:
  source_hash: 5602ef105c3da7e47497bfed8fc343dd8d7f3c019ff7e423a08b25092c5a1837
---

# 채널 위치 파싱

OpenClaw는 채팅 채널의 공유 위치를 다음과 같이 정규화합니다.

- 인바운드 본문에 추가된 사람이 읽을 수 있는 텍스트
- 자동 응답 컨텍스트 페이로드의 구조화된 필드입니다.

현재 지원되는 것:

- **텔레그램**(위치 핀 + 장소 + 실시간 위치)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **행렬** (`m.location` 및 `geo_uri`)

## 텍스트 서식 지정

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

위치가 있으면 다음 필드가 `ctx`에 추가됩니다.

- `LocationLat` (숫자)
- `LocationLon` (숫자)
- `LocationAccuracy` (숫자, 미터; 선택 사항)
- `LocationName` (문자열, 선택사항)
- `LocationAddress` (문자열; 선택사항)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (부울)

## 채널 노트

- **텔레그램**: 장소는 `LocationName/LocationAddress`에 매핑됩니다. 실시간 위치는 `live_period`를 사용합니다.
- **WhatsApp**: `locationMessage.comment` 및 `liveLocationMessage.caption`가 캡션 줄로 추가됩니다.
- **매트릭스**: `geo_uri`는 핀 위치로 구문 분석됩니다. 고도는 무시되고 `LocationIsLive`는 항상 false입니다.
