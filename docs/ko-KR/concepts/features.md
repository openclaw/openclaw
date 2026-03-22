---
title: "기능"
summary: "채널, 라우팅, 미디어, UX 전반에 걸친 OpenClaw 기능."
read_when:
  - OpenClaw 가 지원하는 전체 목록이 필요할 때
x-i18n:
  source_path: docs/concepts/features.md
---

# 기능

## 하이라이트

<Columns>
  <Card title="채널" icon="message-square">
    단일 Gateway 로 WhatsApp, Telegram, Discord, iMessage 를 지원합니다.
  </Card>
  <Card title="플러그인" icon="plug">
    확장을 통해 Mattermost 등을 추가합니다.
  </Card>
  <Card title="라우팅" icon="route">
    격리된 세션을 통한 멀티 에이전트 라우팅.
  </Card>
  <Card title="미디어" icon="image">
    이미지, 오디오, 문서의 입출력.
  </Card>
  <Card title="앱 및 UI" icon="monitor">
    Web Control UI 및 macOS 컴패니언 앱.
  </Card>
  <Card title="모바일 노드" icon="smartphone">
    페어링, 음성/채팅, 풍부한 디바이스 명령을 갖춘 iOS 및 Android 노드.
  </Card>
</Columns>

## 전체 목록

**채널:**

- WhatsApp, Telegram, Discord, iMessage (내장)
- Mattermost, Matrix, Microsoft Teams, Nostr 등 (플러그인)
- 멘션 기반 활성화를 통한 그룹 채팅 지원
- 허용 목록 및 페어링을 통한 DM 안전

**에이전트:**

- 도구 스트리밍을 갖춘 내장 에이전트 런타임
- 워크스페이스 또는 발신자별 격리 세션을 갖춘 멀티 에이전트 라우팅
- 세션: 다이렉트 채팅은 공유 `main` 으로 통합; 그룹은 격리
- 긴 응답을 위한 스트리밍 및 청킹

**인증 및 프로바이더:**

- 35 개 이상의 모델 프로바이더 (Anthropic, OpenAI, Google 등)
- OAuth 를 통한 구독 인증 (예: OpenAI Codex)
- 사용자 정의 및 셀프 호스팅 프로바이더 지원 (vLLM, SGLang, Ollama 및 모든 OpenAI 호환 또는 Anthropic 호환 엔드포인트)

**미디어:**

- 이미지, 오디오, 비디오, 문서의 입출력
- 음성 노트 전사
- 여러 프로바이더를 갖춘 텍스트 투 스피치

**앱 및 인터페이스:**

- WebChat 및 브라우저 Control UI
- macOS 메뉴 바 컴패니언 앱
- 페어링, Canvas, 카메라, 화면 녹화, 위치, 음성을 갖춘 iOS 노드
- 페어링, 채팅, 음성, Canvas, 카메라, 디바이스 명령을 갖춘 Android 노드

**도구 및 자동화:**

- 브라우저 자동화, exec, 샌드박싱
- 웹 검색 (Brave, Perplexity, Gemini, Grok, Kimi, Firecrawl)
- Cron 작업 및 하트비트 스케줄링
- Skills, 플러그인, 워크플로 파이프라인 (Lobster)
