---
summary: "Terminal UI (TUI): 어느 기기에서나 게이트웨이에 연결"
read_when:
  - TUI의 초보자 친화적인 사용법을 알고 싶을 때
  - TUI 기능, 명령어 및 단축키의 전체 목록이 필요할 때
title: "TUI"
---

# TUI (Terminal UI)

## 빠른 시작

1. 게이트웨이를 시작합니다.

```bash
openclaw gateway
```

2. TUI를 엽니다.

```bash
openclaw tui
```

3. 메시지를 입력하고 Enter를 누릅니다.

원격 게이트웨이:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

게이트웨이가 비밀번호 인증을 사용하는 경우 `--password`를 사용하세요.

## 화면 구성

- 헤더: 연결 URL, 현재 에이전트, 현재 세션.
- 채팅 로그: 사용자 메시지, 보조 응답, 시스템 알림, 도구 카드.
- 상태 라인: 연결/실행 상태 (연결, 실행 중, 스트리밍, 대기, 오류).
- 푸터: 연결 상태 + 에이전트 + 세션 + 모델 + 생각/상세/추론 + 토큰 수 + 전달.
- 입력: 자동 완성 기능이 있는 텍스트 에디터.

## 정신 모델: 에이전트 + 세션

- 에이전트는 고유한 슬러그입니다 (예: `main`, `research`). 게이트웨이는 목록을 노출합니다.
- 세션은 현재 에이전트에 속합니다.
- 세션 키는 `agent:<agentId>:<sessionKey>`로 저장됩니다.
  - `/session main`을 입력하면, TUI는 `agent:<currentAgent>:main`으로 확장합니다.
  - `/session agent:other:main`을 입력하면 해당 에이전트 세션으로 명시적으로 전환합니다.
- 세션 범위:
  - `per-sender` (기본값): 각 에이전트는 여러 세션을 가집니다.
  - `global`: TUI는 항상 `global` 세션을 사용합니다 (선택기가 비어 있을 수 있음).
- 현재 에이전트 + 세션은 푸터에 항상 표시됩니다.

## 전송 + 전달

- 메시지는 게이트웨이로 전송됩니다; 기본적으로 프로바이더로의 전달은 꺼져 있습니다.
- 전달 켜기:
  - `/deliver on`
  - 또는 설정 패널
  - 또는 `openclaw tui --deliver`로 시작

## 선택기 + 오버레이

- 모델 선택기: 사용 가능한 모델 목록과 세션 재정의를 설정합니다.
- 에이전트 선택기: 다른 에이전트를 선택합니다.
- 세션 선택기: 현재 에이전트에 대한 세션만 표시합니다.
- 설정: 전달, 도구 출력 확장, 그리고 생각 가시성을 토글합니다.

## 키보드 단축키

- Enter: 메시지 전송
- Esc: 활성 실행 중단
- Ctrl+C: 입력 지움 (두 번 눌러 종료)
- Ctrl+D: 종료
- Ctrl+L: 모델 선택기
- Ctrl+G: 에이전트 선택기
- Ctrl+P: 세션 선택기
- Ctrl+O: 도구 출력 확장 토글
- Ctrl+T: 생각 가시성 토글 (히스토리 다시 로드)

## 슬래시 명령어

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

세션 수명 주기:

- `/new` 또는 `/reset` (세션 재설정)
- `/abort` (활성 실행 중단)
- `/settings`
- `/exit`

기타 게이트웨이 슬래시 명령어 (예: `/context`)는 게이트웨이로 전달되어 시스템 출력으로 표시됩니다. [슬래시 명령어](/ko-KR/tools/slash-commands)를 참조하세요.

## 로컬 쉘 명령어

- 줄 앞에 `!`를 붙여서 TUI 호스트에서 로컬 쉘 명령어를 실행합니다.
- TUI는 로컬 실행을 허용하기 위해 세션당 한 번 허용을 묻습니다; 거부하면 해당 세션 동안 `!`는 비활성화 상태로 유지됩니다.
- 명령어는 TUI 작업 디렉터리에서 새롭고 비대화형 셸에서 실행됩니다 (지속적인 `cd`/환경 변수가 없음).
- 단독 `!`는 일반 메시지로 전송됩니다; 선행 공백은 로컬 실행을 트리거하지 않습니다.

## 도구 출력

- 도구 호출은 인수 + 결과가 포함된 카드로 표시됩니다.
- Ctrl+O는 축소/확장된 뷰 사이를 토글합니다.
- 도구 실행 중에는 부분 업데이트가 동일한 카드로 스트리밍됩니다.

## 히스토리 + 스트리밍

- 연결 시, TUI는 최신 히스토리 (기본 200 메시지)를 로드합니다.
- 스트리밍 응답은 완전히 처리될 때까지 제자리에서 업데이트됩니다.
- TUI는 에이전트 도구 이벤트도 들어와 더 풍부한 도구 카드를 제공합니다.

## 연결 세부사항

- TUI는 게이트웨이에 `mode: "tui"`로 등록됩니다.
- 재연결 시 시스템 메시지가 표시되며, 이벤트 간격이 로그에 표시됩니다.

## 옵션

- `--url <url>`: 게이트웨이 WebSocket URL (기본값은 구성 또는 `ws://127.0.0.1:<port>`)
- `--token <token>`: 게이트웨이 토큰 (필요한 경우)
- `--password <password>`: 게이트웨이 비밀번호 (필요한 경우)
- `--session <key>`: 세션 키 (기본: `main`, 전역 범위일 때는 `global`)
- `--deliver`: 보조 응답을 프로바이더로 전달 (기본 끔)
- `--thinking <level>`: 전송에 대한 생각 수준 재정의
- `--timeout-ms <ms>`: 에이전트 시간 초과 밀리초 (기본값 `agents.defaults.timeoutSeconds`)

참고: `--url`을 설정하면 TUI는 구성이나 환경 자격 증명을 사용하지 않습니다. `--token` 또는 `--password`를 명시적으로 전달하세요. 명시적 자격 증명이 없으면 오류가 발생합니다.

## 문제 해결

메시지 전송 후 출력 없음:

- TUI에서 `/status`를 실행하여 게이트웨이 연결 및 대기/바쁜 상태를 확인합니다.
- 게이트웨이 로그 확인: `openclaw logs --follow`.
- 에이전트가 실행 가능한지 확인: `openclaw status` 및 `openclaw models status`.
- 채널에서 메시지를 기대한다면, 전달을 활성화합니다 (`/deliver on` 또는 `--deliver`).
- `--history-limit <n>`: 불러올 히스토리 항목 수 (기본값 200)

## 연결 문제 해결

- `disconnected`: 게이트웨이가 실행 중인지 확인하고 `--url/--token/--password`가 올바른지 확인합니다.
- 선택기 내 에이전트 없음: `openclaw agents list`와 라우팅 구성을 확인합니다.
- 빈 세션 선택기: 전역 범위에 있거나 아직 세션이 없을 수 있습니다.
