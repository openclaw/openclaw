---
read_when:
    - SOUL Evil 후크를 활성화하거나 조정하고 싶습니다.
    - 퍼지 창이나 무작위 기회의 페르소나 교환을 원합니다.
summary: SOUL Evil Hook(SOUL.md를 SOUL_EVIL.md로 교체)
title: 소울 이블 훅
x-i18n:
    generated_at: "2026-02-08T16:05:58Z"
    model: gtx
    provider: google-translate
    source_hash: 32aba100712317d1a668d482a45694c31346229f540cfefea742dc22ce578221
    source_path: hooks/soul-evil.md
    workflow: 15
---

# 소울 이블 훅

SOUL Evil 후크는 **주입** `SOUL.md` 만족하다 `SOUL_EVIL.md` 동안
퍼지 창 또는 무작위로. 그렇습니다 **~ 아니다** 디스크의 파일을 수정합니다.

## 작동 방식

언제 `agent:bootstrap` 달릴 때, 걸이는 대체할 수 있습니다 `SOUL.md` 메모리의 내용
시스템 프롬프트가 조립되기 전에. 만약에 `SOUL_EVIL.md` 누락되었거나 비어 있습니다.
OpenClaw는 경고를 기록하고 정상 상태를 유지합니다. `SOUL.md`.

하위 에이전트 실행은 다음과 같습니다. **~ 아니다** 포함하다 `SOUL.md` 부트스트랩 파일에 있으므로 이 후크는
하위 에이전트에는 영향을 미치지 않습니다.

## 할 수 있게 하다

```bash
openclaw hooks enable soul-evil
```

그런 다음 구성을 설정합니다.

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

만들다 `SOUL_EVIL.md` 에이전트 작업 영역 루트(옆에 있음) `SOUL.md`).

## 옵션

- `file` (문자열): 대체 SOUL 파일 이름(기본값: `SOUL_EVIL.md`)
- `chance` (숫자 0–1): 실행당 무작위로 사용할 확률 `SOUL_EVIL.md`
- `purge.at` (HH:mm): 일일 퍼지 시작(24시간제)
- `purge.duration` (기간): 창 길이(예: `30s`, `10m`, `1h`)

**상위:** 퍼지 창은 기회를 이깁니다.

**시간대:** 용도 `agents.defaults.userTimezone` 설정되면; 그렇지 않으면 호스트 시간대입니다.

## 메모

- 디스크에는 파일이 기록되거나 수정되지 않습니다.
- 만약에 `SOUL.md` 부트스트랩 목록에 없으면 후크는 아무 작업도 수행하지 않습니다.

## 참조

- [후크](/automation/hooks)
