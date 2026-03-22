---
summary: "Elevated exec 모드: 샌드박스된 에이전트에서 Gateway 호스트에 명령 실행"
read_when:
  - Elevated 모드 기본값, 허용 목록 또는 슬래시 명령 동작을 조정할 때
  - 샌드박스된 에이전트가 호스트에 접근하는 방법을 이해할 때
title: "Elevated 모드"
x-i18n:
  source_path: docs/tools/elevated.md
---

# Elevated 모드

에이전트가 샌드박스 내에서 실행될 때, `exec` 명령은 샌드박스 환경에 제한됩니다. **Elevated 모드**는 에이전트가 탈출하여 구성 가능한 승인 게이트와 함께 Gateway 호스트에서 명령을 실행할 수 있게 합니다.

<Info>
  Elevated 모드는 에이전트가 **샌드박스**된 경우에만 동작을 변경합니다.
  샌드박스되지 않은 에이전트의 경우 exec 는 이미 호스트에서 실행됩니다.
</Info>

## 디렉티브

세션별로 슬래시 명령으로 Elevated 모드를 제어합니다:

| 디렉티브         | 기능                                              |
| ---------------- | ------------------------------------------------- |
| `/elevated on`   | Gateway 호스트에서 실행, exec 승인 유지           |
| `/elevated ask`  | `on`과 동일 (별칭)                                |
| `/elevated full` | Gateway 호스트에서 실행 **및** exec 승인 건너뛰기 |
| `/elevated off`  | 샌드박스 제한 실행으로 복귀                       |

`/elev on|off|ask|full`로도 사용 가능합니다.

인수 없이 `/elevated`를 보내면 현재 수준을 확인합니다.

## 작동 방식

<Steps>
  <Step title="가용성 확인">
    Elevated 가 설정에서 활성화되어야 하고 발신자가 허용 목록에 있어야 합니다:

    ```json5
    {
      tools: {
        elevated: {
          enabled: true,
          allowFrom: {
            discord: ["user-id-123"],
            whatsapp: ["+15555550123"],
          },
        },
      },
    }
    ```

  </Step>

  <Step title="수준 설정">
    세션 기본값을 설정하려면 디렉티브 전용 메시지를 보냅니다:

    ```
    /elevated full
    ```

    또는 인라인으로 사용합니다 (해당 메시지에만 적용):

    ```
    /elevated on run the deployment script
    ```

  </Step>

  <Step title="명령이 호스트에서 실행">
    Elevated 가 활성화되면 `exec` 호출이 샌드박스 대신 Gateway 호스트로 라우팅됩니다. `full` 모드에서는 exec 승인이 건너뛰어집니다. `on`/`ask` 모드에서는 구성된 승인 규칙이 여전히 적용됩니다.
  </Step>
</Steps>

## 해결 순서

1. **인라인 디렉티브** (해당 메시지에만 적용)
2. **세션 재정의** (디렉티브 전용 메시지 전송으로 설정)
3. **전역 기본값** (설정의 `agents.defaults.elevatedDefault`)

## 가용성 및 허용 목록

- **전역 게이트**: `tools.elevated.enabled` (`true`여야 함)
- **발신자 허용 목록**: 채널별 목록이 있는 `tools.elevated.allowFrom`
- **에이전트별 게이트**: `agents.list[].tools.elevated.enabled` (추가 제한만 가능)
- **에이전트별 허용 목록**: `agents.list[].tools.elevated.allowFrom` (발신자가 전역 + 에이전트별 모두 일치해야 함)
- **Discord 폴백**: `tools.elevated.allowFrom.discord`가 생략되면 `channels.discord.allowFrom`이 폴백으로 사용됨
- **모든 게이트를 통과해야 함**; 그렇지 않으면 Elevated 를 사용할 수 없는 것으로 처리

허용 목록 항목 형식:

| 접두사                  | 매칭 대상                       |
| ----------------------- | ------------------------------- |
| (없음)                  | 발신자 ID, E.164 또는 From 필드 |
| `name:`                 | 발신자 표시 이름                |
| `username:`             | 발신자 사용자 이름              |
| `tag:`                  | 발신자 태그                     |
| `id:`, `from:`, `e164:` | 명시적 ID 타겟팅                |

## Elevated 가 제어하지 않는 것

- **도구 정책**: 도구 정책에 의해 `exec`가 거부되면 Elevated 가 이를 재정의할 수 없음
- **`/exec`와 별개**: `/exec` 디렉티브는 인증된 발신자를 위한 세션별 exec 기본값을 조정하며 Elevated 모드를 필요로 하지 않음

## 관련 문서

- [Exec 도구](/tools/exec) — 셸 명령 실행
- [Exec 승인](/tools/exec-approvals) — 승인 및 허용 목록 시스템
- [샌드박싱](/gateway/sandboxing) — 샌드박스 구성
- [샌드박스 vs 도구 정책 vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
