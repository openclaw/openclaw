---
read_when:
    - 첫 번째 에이전트 실행 시 어떤 일이 발생하는지 이해
    - 부트스트래핑 파일이 어디에 있는지 설명
    - 온보딩 ID 설정 디버깅
sidebarTitle: Bootstrapping
summary: 작업 공간 및 ID 파일을 시드하는 에이전트 부트스트래핑 의식
title: 에이전트 부트스트래핑
x-i18n:
    generated_at: "2026-02-08T16:04:06Z"
    model: gtx
    provider: google-translate
    source_hash: 4a08b5102f25c6c4bcdbbdd44384252a9e537b245a7b070c4961a72b4c6c6601
    source_path: start/bootstrapping.md
    workflow: 15
---

# 에이전트 부트스트래핑

부트스트래핑은 **첫 실행** 에이전트 작업 공간을 준비하는 의식과
신원 정보를 수집합니다. 온보딩 후 에이전트가 시작될 때 발생합니다.
처음으로.

## 부트스트래핑이 하는 일

첫 번째 에이전트 실행 시 OpenClaw는 작업 공간을 부트스트랩합니다(기본값)
`~/.openclaw/workspace`):

- 씨앗 `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- 짧은 Q&A 의식을 실행합니다(한 번에 하나의 질문).
- ID + 기본 설정을 작성합니다. `IDENTITY.md`, `USER.md`, `SOUL.md`.
- 제거하다 `BOOTSTRAP.md` 완료되면 한 번만 실행됩니다.

## 실행되는 곳

부트스트래핑은 항상 다음에서 실행됩니다. **게이트웨이 호스트**. macOS 앱이 다음에 연결되는 경우
원격 게이트웨이, 작업 공간 및 부트스트래핑 파일은 해당 원격에 있습니다.
기계.

<Note>
게이트웨이가 다른 시스템에서 실행되면 게이트웨이에서 작업공간 파일을 편집합니다.
호스트(예: `user@gateway-host:~/.openclaw/workspace`).
</Note>

## 관련 문서

- macOS 앱 온보딩: [온보딩](/start/onboarding)
- 작업공간 레이아웃: [상담원 작업공간](/concepts/agent-workspace)
