---
title: "에이전트 부트스트래핑"
summary: "워크스페이스 및 아이덴티티 파일을 시드하는 에이전트 부트스트래핑 의식"
sidebarTitle: "부트스트래핑"
read_when:
  - 첫 에이전트 실행 시 무엇이 일어나는지 이해할 때
  - 부트스트래핑 파일이 어디에 있는지 설명할 때
  - 온보딩 아이덴티티 설정을 디버깅할 때
x-i18n:
  source_path: docs/start/bootstrapping.md
---

# 에이전트 부트스트래핑

부트스트래핑은 에이전트 워크스페이스를 준비하고 아이덴티티 세부 정보를 수집하는 **최초 실행** 의식입니다. 온보딩 이후, 에이전트가 처음 시작될 때 발생합니다.

## 부트스트래핑이 하는 일

첫 에이전트 실행 시, OpenClaw 는 워크스페이스(기본값 `~/.openclaw/workspace`)를 부트스트랩합니다:

- `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md` 를 시드합니다.
- 짧은 Q&A 의식을 실행합니다(한 번에 하나의 질문).
- 아이덴티티 + 선호도를 `IDENTITY.md`, `USER.md`, `SOUL.md` 에 기록합니다.
- 완료 시 `BOOTSTRAP.md` 를 제거하여 한 번만 실행되도록 합니다.

## 실행 위치

부트스트래핑은 항상 **Gateway 호스트**에서 실행됩니다. macOS 앱이 원격 Gateway 에 연결하는 경우, 워크스페이스와 부트스트래핑 파일은 해당 원격 머신에 있습니다.

<Note>
Gateway 가 다른 머신에서 실행될 때는, Gateway 호스트에서 워크스페이스 파일을 편집하세요
(예: `user@gateway-host:~/.openclaw/workspace`).
</Note>

## 관련 문서

- macOS 앱 온보딩: [온보딩](/start/onboarding)
- 워크스페이스 레이아웃: [에이전트 워크스페이스](/concepts/agent-workspace)
