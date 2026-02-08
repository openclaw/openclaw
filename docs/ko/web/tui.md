---
read_when:
    - 초보자에게 친숙한 TUI 연습을 원합니다.
    - TUI 기능, 명령 및 바로가기의 전체 목록이 필요합니다.
summary: '터미널 UI(TUI): 모든 머신에서 게이트웨이에 연결'
title: TUI
x-i18n:
    generated_at: "2026-02-08T16:07:59Z"
    model: gtx
    provider: google-translate
    source_hash: 6ab8174870e4722d76af61915b9bb020dc6df1ddacc406e2f5a80416b6e7f904
    source_path: web/tui.md
    workflow: 15
---

# TUI(터미널 UI)

## 빠른 시작

1. 게이트웨이를 시작하십시오.

```bash
openclaw gateway
```

2. TUI를 엽니다.

```bash
openclaw tui
```

3. 메시지를 입력하고 Enter를 누르세요.

원격 게이트웨이:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

사용 `--password` 게이트웨이가 비밀번호 인증을 사용하는 경우.

## 당신이 보는 것

- 헤더: 연결 URL, 현재 에이전트, 현재 세션.
- 채팅 로그: 사용자 메시지, 보조 응답, 시스템 알림, 도구 카드.
- 상태 표시줄: 연결/실행 상태(연결 중, 실행 중, 스트리밍, 유휴, 오류)
- 바닥글: 연결 상태 + 에이전트 + 세션 + 모델 + 생각/상세/추론 + 토큰 수 + 전달.
- 입력: 자동 완성 기능이 있는 텍스트 편집기.

## 정신 모델: 상담원 + 세션

- 에이전트는 고유한 슬러그입니다(예: `main`, `research`). 게이트웨이는 목록을 공개합니다.
- 세션은 현재 에이전트에 속합니다.
- 세션 키는 다음과 같이 저장됩니다. `agent:<agentId>:<sessionKey>`.
  - 당신이 입력하는 경우 `/session main`, TUI는 이를 다음으로 확장합니다. `agent:<currentAgent>:main`.
  - 당신이 입력하는 경우 `/session agent:other:main`, 해당 에이전트 세션으로 명시적으로 전환합니다.
- 세션 범위:
  - `per-sender` (기본값): 각 에이전트에는 여러 세션이 있습니다.
  - `global`: TUI는 항상 `global` 세션(선택기가 비어 있을 수 있음)
- 현재 상담원 + 세션은 항상 바닥글에 표시됩니다.

## 발송 + 배송

- 메시지는 게이트웨이로 전송됩니다. 공급자에게 전달하는 것은 기본적으로 꺼져 있습니다.
- 배달 켜기:
  - `/deliver on`
  - 또는 설정 패널
  - 또는 시작 `openclaw tui --deliver`

## 선택기 + 오버레이

- 모델 선택기: 사용 가능한 모델을 나열하고 세션 재정의를 설정합니다.
- 상담원 선택기: 다른 상담원을 선택하세요.
- 세션 선택기: 현재 에이전트의 세션만 표시합니다.
- 설정: 전달, 도구 출력 확장 및 사고 가시성을 전환합니다.

## 키보드 단축키

- Enter: 메시지 보내기
- Esc: 활성 실행 중단
- Ctrl+C: 입력 지우기(종료하려면 두 번 누르세요)
- Ctrl+D: 종료
- Ctrl+L: 모델 선택기
- Ctrl+G: 에이전트 선택기
- Ctrl+P: 세션 선택기
- Ctrl+O: 도구 출력 확장 전환
- Ctrl+T: 사고 가시성 전환(기록 다시 로드)

## 슬래시 명령

핵심:

- `/help`
- `/status`
- `/agent <id>` (또는 `/agents`)
- `/session <key>` (또는 `/sessions`)
- `/model <provider/model>` (또는 `/models`)

세션 제어:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (별명: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

세션 수명주기:

- `/new` 또는 `/reset` (세션을 재설정)
- `/abort` (활성 실행 중단)
- `/settings`
- `/exit`

기타 게이트웨이 슬래시 명령(예: `/context`)은 게이트웨이로 전달되어 시스템 출력으로 표시됩니다. 보다 [슬래시 명령](/tools/slash-commands).

## 로컬 쉘 명령

- 줄 앞에 다음을 붙입니다. `!` TUI 호스트에서 로컬 셸 명령을 실행합니다.
- TUI는 세션당 한 번씩 로컬 실행을 허용하라는 메시지를 표시합니다. 쇠퇴하는 유지 `!` 세션에 대해 비활성화되었습니다.
- 명령은 TUI 작업 디렉터리의 새로운 비대화형 셸에서 실행됩니다. `cd`/env).
- 홀로 `!` 일반 메시지로 전송됩니다. 선행 공백은 로컬 실행을 트리거하지 않습니다.

## 도구 출력

- 도구 호출은 인수 + 결과가 포함된 카드로 표시됩니다.
- Ctrl+O는 축소/확장 보기 사이를 전환합니다.
- 도구가 실행되는 동안 부분 업데이트가 동일한 카드로 스트리밍됩니다.

## 기록 + 스트리밍

- 연결 시 TUI는 최신 기록(기본값 200개 메시지)을 로드합니다.
- 스트리밍 응답은 완료될 때까지 업데이트됩니다.
- TUI는 또한 더 풍부한 도구 카드에 대한 에이전트 도구 이벤트를 수신합니다.

## 연결 세부정보

- TUI는 게이트웨이에 다음과 같이 등록됩니다. `mode: "tui"`.
- 다시 연결하면 시스템 메시지가 표시됩니다. 이벤트 공백이 로그에 표시됩니다.

## 옵션

- `--url <url>`: 게이트웨이 WebSocket URL(기본값은 config 또는 `ws://127.0.0.1:<port>`)
- `--token <token>`: 게이트웨이 토큰(필요한 경우)
- `--password <password>`: 게이트웨이 비밀번호(필요한 경우)
- `--session <key>`: 세션 키(기본값: `main`, 또는 `global` 범위가 전역인 경우)
- `--deliver`: 제공자에게 보조 응답 전달(기본적으로 꺼짐)
- `--thinking <level>`: 보내기에 대한 사고 수준 무시
- `--timeout-ms <ms>`: 에이전트 시간 초과(ms)(기본값: `agents.defaults.timeoutSeconds`)

참고: 설정할 때 `--url`, TUI는 구성 또는 환경 자격 증명으로 대체되지 않습니다.
통과하다 `--token` 또는 `--password` 명시적으로. 명시적 자격 증명이 누락되면 오류가 발생합니다.

## 문제 해결

메시지를 보낸 후 출력이 없습니다.

- 달리다 `/status` TUI에서 게이트웨이가 연결되어 있고 유휴/사용 중인지 확인합니다.
- 게이트웨이 로그를 확인하세요. `openclaw logs --follow`.
- 에이전트가 실행될 수 있는지 확인합니다. `openclaw status` 그리고 `openclaw models status`.
- 채팅 채널에 메시지가 전달될 것으로 예상되는 경우 전달을 활성화하세요(`/deliver on` 또는 `--deliver`).
- `--history-limit <n>`: 로드할 기록 항목(기본값 200)

## 연결 문제 해결

- `disconnected`: 게이트웨이가 실행 중이고 `--url/--token/--password` 맞습니다.
- 선택 도구에 에이전트 없음: 확인 `openclaw agents list` 그리고 라우팅 구성.
- 빈 세션 선택기: 전역 범위에 있거나 아직 세션이 없을 수 있습니다.
