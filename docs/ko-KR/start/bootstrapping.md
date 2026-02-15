---
summary: "Agent bootstrapping ritual that seeds the workspace and identity files"
read_when:
  - Understanding what happens on the first agent run
  - Explaining where bootstrapping files live
  - Debugging onboarding identity setup
title: "Agent Bootstrapping"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_hash: 4a08b5102f25c6c4bcdbbdd44384252a9e537b245a7b070c4961a72b4c6c6601
---

# 에이전트 부트스트래핑

부트스트래핑은 상담원 작업 영역을 준비하고
신원 정보를 수집합니다. 온보딩 후 에이전트가 시작될 때 발생합니다.
처음으로.

## 부트스트래핑이 하는 일

첫 번째 에이전트 실행 시 OpenClaw는 작업 공간을 부트스트랩합니다(기본값)
`~/.openclaw/workspace`):

- 시드 `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- 짧은 Q&A 의식을 진행합니다(한 번에 하나의 질문).
- `IDENTITY.md`, `USER.md`, `SOUL.md`에 ID + 선호도를 씁니다.
- 완료되면 `BOOTSTRAP.md`를 제거하므로 한 번만 실행됩니다.

## 실행 위치

부트스트래핑은 항상 **게이트웨이 호스트**에서 실행됩니다. macOS 앱이 다음에 연결되는 경우
원격 게이트웨이, 작업 공간 및 부트스트래핑 파일은 해당 원격에 있습니다.
기계.

<Note>
게이트웨이가 다른 시스템에서 실행되면 게이트웨이에서 작업공간 파일을 편집합니다.
호스트(예: `user@gateway-host:~/.openclaw/workspace`).
</Note>

## 관련 문서

- macOS 앱 온보딩: [온보딩](/start/onboarding)
- 작업공간 레이아웃 : [에이전트 작업공간](/concepts/agent-workspace)
