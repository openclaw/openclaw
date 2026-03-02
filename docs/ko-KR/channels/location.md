---
summary: "인바운드 채널 위치 구문 분석 (Telegram + WhatsApp) 및 컨텍스트 필드"
read_when:
  - 채널 위치 구문 분석 추가 또는 수정 중
  - 에이전트 프롬프트 또는 도구에서 위치 컨텍스트 필드 사용 중
title: "채널 위치 구문 분석"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/location.md
  workflow: 15
---

# 채널 위치 구문 분석

OpenClaw 는 채팅 채널에서 공유된 위치를 정규화합니다:

- 인바운드 본문에 추가된 사람이 읽을 수 있는 텍스트, 그리고
- 자동 회신 컨텍스트 페이로드의 구조화된 필드.

현재 지원됨:

- **Telegram** (위치 핀 + 장소 + 실시간 위치)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` 과 `geo_uri`)

## 텍스트 서식

위치는 괄호 없이 친화적인 줄로 렌더링됩니다:

- 핀:
  - `📍 48.858844, 2.294351 ±12m`
- 명명된 장소:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- 실시간 공유:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

채널이 캡션/설명을 포함하면 다음 줄에 추가됩니다:

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## 컨텍스트 필드

위치가 있을 때 다음 필드가 `ctx` 에 추가됩니다:

- `LocationLat` (숫자)
- `LocationLon` (숫자)
- `LocationAccuracy` (숫자, 미터. 선택 사항)
- `LocationName` (문자열. 선택 사항)
- `LocationAddress` (문자열. 선택 사항)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (부울)

## 채널 참고사항

- **Telegram**: 장소는 `LocationName/LocationAddress` 로 매핑. 실시간 위치는 `live_period` 를 사용합니다.
- **WhatsApp**: `locationMessage.comment` 및 `liveLocationMessage.caption` 은 캡션 줄로 추가됩니다.
- **Matrix**: `geo_uri` 는 핀 위치로 구문 분석. 높이는 무시되고 `LocationIsLive` 는 항상 거짓입니다.
