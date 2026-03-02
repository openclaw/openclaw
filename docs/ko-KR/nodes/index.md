---
summary: "노드 개요: 모바일 및 데스크톱 장치 기능"
read_when:
  - 노드 의 역할을 이해할 때
  - 노드를 쌍으로 만들고 연결할 때
title: "노드"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: nodes/index.md
  workflow: 15
---

# 노드

노드는 macOS, iOS 및 Android 의 동반 앱입니다. Gateway 에 연결하고 다음을 제공합니다:

- Canvas (웹 UI 렌더링)
- Camera (사진 및 비디오 캡처)
- Screen (화면 기록)
- Voice (음성 입력 및 출력)
- 기타 디바이스 기능

## 노드 설정

1. Gateway 를 시작합니다: `openclaw gateway --port 18789`
2. 노드 앱을 설치하고 열기 (macOS, iOS 또는 Android)
3. Gateway 를 발견하도록 앱에 지시
4. 페어링 요청 승인: `openclaw nodes approve <requestId>`
5. 확인: `openclaw nodes status`

## 플랫폼

- [macOS](/ko-KR/platforms/macos)
- [iOS](/ko-KR/platforms/ios)
- [Android](/ko-KR/platforms/android)

## 관련 문서

- [Gateway 페어링](/ko-KR/gateway/pairing)
- [발견](/ko-KR/gateway/discovery)
- [Network](/ko-KR/network)
