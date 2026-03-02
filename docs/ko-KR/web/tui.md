---
summary: "터미널 UI(TUI): 모든 머신에서 Gateway에 연결"
read_when:
  - TUI의 초보자 친화적 안내가 필요할 때
  - TUI 기능, 커맨드 및 단축키의 완전한 목록이 필요할 때
title: "TUI"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: web/tui.md
workflow: 15
---

# TUI(터미널 UI)

## 빠른 시작

1. Gateway를 시작합니다.

```bash
openclaw gateway
```

2. TUI를 엽니다.

```bash
openclaw tui
```

3. 메시지를 입력하고 Enter를 누릅니다.

원격 Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Gateway가 암호 인증을 사용하는 경우 `--password`를 사용합니다.

## 표시되는 내용

- 헤더: 연결 URL, 현재 에이전트, 현재 세션.
- 채팅 로그: 사용자 메시지, 어시스턴트 회신, 시스템 알림, 도구 카드.
- 상태 줄: 연결/실행 상태(연결 중, 실행 중, 스트리밍, 유휴, 오류).
- 바닥글: 연결 상태 + 에이전트 + 세션 + 모델 + 사고/자세/추론 + 토큰 개수 + 전달.
- 입력: 자동완성이 있는 텍스트 편집기.

## 정신 모델: 에이전트 + 세션

- 에이전트는 고유한 슬러그입니다(예: `main`, `research`). Gateway가 목록을 노출합니다.
- 세션은 현재 에이전트에 속합니다.
- 세션 키는 `agent:<agentId>:<sessionKey>`로 저장됩니다.
  - `/session main`을 입력하면 TUI는 이를 `agent:<currentAgent>:main`으로 확장합니다.
  - `/session agent:other:main`을 입력하면 해당 에이전트 세션으로 명시적으로 전환합니다.
- 세션 범위:
  - `per-sender`(기본값): 각 에이전트는 많은 세션을 가집니다.
  - `global`: TUI는 항상 `global` 세션을 사용합니다(선택기는 비어있을 수 있음).
- 현재 에이전트 + 세션은 항상 바닥글에 표시됩니다.

## 전송 + 전달

- 메시지는 Gateway로 전송됩니다; 제공자에 대한 전달은 기본값으로 꺼져 있습니다.
- 전달 켜기:
  - `/deliver on`
  - 또는 Settings 패널
  - 또는 `openclaw tui --deliver`로 시작

## 선택기 + 오버레이

- 모델 선택기: 사용 가능한 모델을 나열하고 세션 오버라이드를 설정합니다.
- 에이전트 선택기: 다른 에이전트를 선택합니다.
- 세션 선택기: 현재 에이전트의 세션만 표시합니다.
- 설정: 전달, 도구 출력 확장 및 사고 가시성을 전환합니다.

## 키보드 단축키

- Enter: 메시지 보내기
- Esc: 활성 실행 중단
- Ctrl+C: 입력 지우기(두 번 눌러 종료)
- Ctrl+D: 종료
- Ctrl+L: 모델 선택기
- Ctrl+G: 에이전트 선택기
- Ctrl+P: 세션 선택기
- Ctrl+O: 도구 출력 확장 전환
- Ctrl+T: 사고 가시성 전환(히스토리 다시 로드)

## Slash 커맨드

핵심:

- `/help`
- `/status`
- `/agent <id>`(또는 `/agents`)
- `/session <key>`(또는 `/sessions`)
- `/model <provider/model>`(또는 `/models`)

세션 제어:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>`(별칭: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

세션 라이프사이클:

- `/new` 또는 `/reset`(세션 재설정)
- `/abort`(활성 실행 중단)
- `/settings`
- `/exit`

다른 Gateway Slash 커맨드(예: `/context`)는 Gateway로 전달되고 시스템 출력으로 표시됩니다. [Slash 커맨드](/tools/slash-commands)를 참고합니다.

## 로컬 셸 커맨드

- TUI 호스트에서 로컬 셸 커맨드를 실행하려면 줄 앞에 `!`를 붙입니다.
- TUI는 세션당 한 번 로컬 실행을 허용하도록 프롬프트합니다; 거부하면 세션에 대해 `!`가 비활성화됩니다.
- 커맨드는 TUI 작업 디렉터리에서 신선하고 비 대화형 셸에서 실행됩니다(지속적인 `cd`/env 없음).
- 독립 `!`는 정상 메시지로 전송됩니다; 선행 공백은 로컬 exec을 트리거하지 않습니다.

## 도구 출력

- 도구 호출은 인수 + 결과가 있는 카드로 표시됩니다.
- Ctrl+O는 축소/확장 보기 사이를 전환합니다.
- 도구가 실행되는 동안 부분 업데이트는 같은 카드로 스트리밍됩니다.

## 히스토리 + 스트리밍

- 연결 시 TUI는 최신 히스토리를 로드합니다(기본값 200 메시지).
- 스트리밍 응답은 최종화될 때까지 제자리에서 업데이트됩니다.
- TUI는 또한 더 풍부한 도구 카드용 에이전트 도구 이벤트를 청취합니다.

## 연결 세부 정보

- TUI는 `mode: "tui"`로 Gateway에 등록합니다.
- 재연결은 시스템 메시지를 표시; 이벤트 간격이 로그에 표시됩니다.

## 옵션

- `--url <url>`: Gateway WebSocket URL(기본값: 구성 또는 `ws://127.0.0.1:<port>`)
- `--token <token>`: Gateway 토큰(필요한 경우)
- `--password <password>`: Gateway 암호(필요한 경우)
- `--session <key>`: 세션 키(기본값: `main`, 범위가 전역이면 `global`)
- `--deliver`: 어시스턴트 회신을 제공자로 전달(기본값 꺼짐)
- `--thinking <level>`: 전송을 위한 사고 레벨 오버라이드
- `--timeout-ms <ms>`: 에이전트 타임아웃 ms(기본값: `agents.defaults.timeoutSeconds`)

참고: `--url`을 설정하면 TUI는 구성 또는 환경 자격증명으로 폴백하지 않습니다.
`--token` 또는 `--password`를 명시적으로 전달합니다. 명시적 자격증명 누락은 오류입니다.

## 문제 해결

메시지 전송 후 출력 없음:

- TUI에서 `/status`를 실행하여 Gateway가 연결되고 유휴/바쁜 상태인지 확인합니다.
- Gateway 로그를 확인합니다: `openclaw logs --follow`.
- 에이전트가 실행될 수 있는지 확인합니다: `openclaw status` 및 `openclaw models status`.
- 채팅 채널에서 메시지를 예상하면 전달을 활성화합니다(`/deliver on` 또는 `--deliver`).
- `--history-limit <n>`: 로드할 히스토리 항목(기본값 200)

## 연결 문제 해결

- `disconnected`: Gateway가 실행 중인지, `--url/--token/--password`가 올바른지 확인합니다.
- 선택기에 에이전트 없음: `openclaw agents list` 및 라우팅 구성을 확인합니다.
- 빈 세션 선택기: 전역 범위에 있거나 아직 세션이 없을 수 있습니다.
