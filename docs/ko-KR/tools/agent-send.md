---
summary: "CLI 에서 에이전트 턴을 실행하고 선택적으로 채널에 답변 전달"
read_when:
  - 스크립트나 명령줄에서 에이전트 실행을 트리거하고 싶을 때
  - 프로그래밍 방식으로 에이전트 답변을 채팅 채널에 전달해야 할 때
title: "Agent Send"
x-i18n:
  source_path: docs/tools/agent-send.md
---

# Agent Send

`openclaw agent`는 인바운드 채팅 메시지 없이 명령줄에서 단일 에이전트 턴을 실행합니다. 스크립트 워크플로, 테스트 및 프로그래밍 방식 전달에 사용합니다.

## 빠른 시작

<Steps>
  <Step title="간단한 에이전트 턴 실행">
    ```bash
    openclaw agent --message "What is the weather today?"
    ```

    이 명령은 메시지를 Gateway 를 통해 보내고 답변을 출력합니다.

  </Step>

  <Step title="특정 에이전트 또는 세션 대상 지정">
    ```bash
    # 특정 에이전트 대상
    openclaw agent --agent ops --message "Summarize logs"

    # 전화번호 대상 (세션 키 도출)
    openclaw agent --to +15555550123 --message "Status update"

    # 기존 세션 재사용
    openclaw agent --session-id abc123 --message "Continue the task"
    ```

  </Step>

  <Step title="채널에 답변 전달">
    ```bash
    # WhatsApp 에 전달 (기본 채널)
    openclaw agent --to +15555550123 --message "Report ready" --deliver

    # Slack 에 전달
    openclaw agent --agent ops --message "Generate report" \
      --deliver --reply-channel slack --reply-to "#reports"
    ```

  </Step>
</Steps>

## 플래그

| 플래그                        | 설명                                                    |
| ----------------------------- | ------------------------------------------------------- |
| `--message \<text\>`          | 보낼 메시지 (필수)                                      |
| `--to \<dest\>`               | 대상 (전화번호, 채팅 ID) 에서 세션 키 도출              |
| `--agent \<id\>`              | 구성된 에이전트 대상 (`main` 세션 사용)                 |
| `--session-id \<id\>`         | ID 로 기존 세션 재사용                                  |
| `--local`                     | 로컬 내장 런타임 강제 (Gateway 건너뛰기)                |
| `--deliver`                   | 채팅 채널에 답변 전송                                   |
| `--channel \<name\>`          | 전달 채널 (whatsapp, telegram, discord, slack 등)       |
| `--reply-to \<target\>`       | 전달 대상 재정의                                        |
| `--reply-channel \<name\>`    | 전달 채널 재정의                                        |
| `--reply-account \<id\>`      | 전달 계정 ID 재정의                                     |
| `--thinking \<level\>`        | 사고 수준 설정 (off, minimal, low, medium, high, xhigh) |
| `--verbose \<on\|full\|off\>` | 상세 수준 설정                                          |
| `--timeout \<seconds\>`       | 에이전트 타임아웃 재정의                                |
| `--json`                      | 구조화된 JSON 출력                                      |

## 동작

- 기본적으로 CLI 는 **Gateway 를 통해** 실행됩니다. 현재 머신에서 내장 런타임을 강제하려면 `--local`을 추가하세요.
- Gateway 에 연결할 수 없는 경우 CLI 는 로컬 내장 실행으로 **폴백**합니다.
- 세션 선택: `--to`는 세션 키를 도출합니다 (그룹/채널 대상은 격리를 유지하고, 직접 채팅은 `main`으로 축소).
- 사고 및 상세 플래그는 세션 저장소에 유지됩니다.
- 출력: 기본적으로 일반 텍스트, 또는 구조화된 페이로드 + 메타데이터를 위해 `--json`.

## 예시

```bash
# JSON 출력으로 간단한 턴
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json

# 사고 수준을 사용한 턴
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium

# 세션과 다른 채널에 전달
openclaw agent --agent ops --message "Alert" --deliver --reply-channel telegram --reply-to "@admin"
```

## 관련 문서

- [Agent CLI 참조](/cli/agent)
- [서브 에이전트](/tools/subagents) — 백그라운드 서브 에이전트 생성
- [세션](/concepts/session) — 세션 키 작동 방식
