---
summary: "SOUL Evil 훅 (SOUL.md 를 SOUL_EVIL.md 로 교체)"
read_when:
  - SOUL Evil 훅을 활성화하거나 조정하려는 경우
  - 퍼지 윈도우 또는 무작위 확률 기반 페르소나 전환이 필요한 경우
title: "SOUL Evil 훅"
---

# SOUL Evil 훅

SOUL Evil 훅은 퍼지 윈도우 동안 또는 무작위 확률에 따라 **주입된** `SOUL.md` 콘텐츠를 `SOUL_EVIL.md` 로 교체합니다. 디스크의 파일은 **수정하지 않습니다**.

## 작동 방식

`agent:bootstrap` 가 실행될 때, 이 훅은 시스템 프롬프트가 조립되기 전에
메모리 상의 `SOUL.md` 콘텐츠를 교체할 수 있습니다. `SOUL_EVIL.md` 이 누락되었거나 비어 있으면,
OpenClaw 는 경고를 기록하고 일반 `SOUL.md` 를 유지합니다.

서브 에이전트 실행에는 부트스트랩 파일에 `SOUL.md` 이 포함되지 않으므로,
이 훅은 서브 에이전트에 영향을 주지 않습니다.

## 활성화

```bash
openclaw hooks enable soul-evil
```

그런 다음 설정을 구성합니다:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

에이전트 워크스페이스 루트(`SOUL.md` 옆)에 `SOUL_EVIL.md` 를 생성합니다.

## 옵션

- `file` (string): 대체 SOUL 파일 이름 (기본값: `SOUL_EVIL.md`)
- `chance` (number 0–1): 실행당 `SOUL_EVIL.md` 를 사용할 무작위 확률
- `purge.at` (HH:mm): 일일 퍼지 시작 시간 (24시간제)
- `purge.duration` (duration): 윈도우 길이 (예: `30s`, `10m`, `1h`)

**우선순위:** 퍼지 윈도우가 확률보다 우선합니다.

**시간대:** 설정된 경우 `agents.defaults.userTimezone` 를 사용하며, 그렇지 않으면 호스트 시간대를 사용합니다.

## 참고

- 디스크에 어떤 파일도 작성되거나 수정되지 않습니다.
- 부트스트랩 목록에 `SOUL.md` 이 없으면, 이 훅은 아무 동작도 하지 않습니다.

## See Also

- [Hooks](/automation/hooks)
