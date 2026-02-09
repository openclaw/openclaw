---
summary: "에이전트 워크스페이스와 아이덴티티 파일을 시드하는 에이전트 부트스트래핑 의식"
read_when:
  - 첫 번째 에이전트 실행 시 무엇이 일어나는지 이해할 때
  - 부트스트래핑 파일의 위치를 설명할 때
  - 26. 디버깅 온보딩 아이덴티티 설정
title: "에이전트 부트스트래핑"
sidebarTitle: "Bootstrapping"
---

# 에이전트 부트스트래핑

부트스트래핑은 에이전트 워크스페이스를 준비하고 아이덴티티 세부 정보를 수집하는 **첫 실행** 의식입니다. 온보딩 이후, 에이전트가 처음 시작될 때 수행됩니다.

## 27. 부트스트래핑이 하는 일

첫 번째 에이전트 실행 시 OpenClaw 는 워크스페이스(기본값
`~/.openclaw/workspace`)를 부트스트랩합니다:

- `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md` 를 시드합니다.
- 짧은 Q&A 의식(한 번에 하나의 질문)을 실행합니다.
- 아이덴티티 + 환경설정을 `IDENTITY.md`, `USER.md`, `SOUL.md` 에 기록합니다.
- 완료되면 `BOOTSTRAP.md` 을 제거하여 한 번만 실행되도록 합니다.

## 실행 위치

부트스트래핑은 항상 **게이트웨이 호스트**에서 실행됩니다. macOS 앱이 원격 Gateway(게이트웨이)에 연결되는 경우, 워크스페이스와 부트스트래핑 파일은 해당 원격 머신에 위치합니다.

<Note>
Gateway(게이트웨이)가 다른 머신에서 실행되는 경우, 워크스페이스 파일은 게이트웨이 호스트에서 편집하십시오(예: `user@gateway-host:~/.openclaw/workspace`).
</Note>

## 관련 문서

- macOS 앱 온보딩: [Onboarding](/start/onboarding)
- 워크스페이스 레이아웃: [Agent workspace](/concepts/agent-workspace)
