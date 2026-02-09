---
summary: "대상별 디버그 로그를 위한 진단 플래그"
read_when:
  - 전역 로깅 레벨을 올리지 않고 대상별 디버그 로그가 필요할 때
  - 지원을 위해 서브시스템별 로그를 캡처해야 할 때
title: "진단 플래그"
---

# 진단 플래그

진단 플래그를 사용하면 전체에 걸쳐 상세 로깅을 켜지 않고도 대상별 디버그 로그를 활성화할 수 있습니다. 플래그는 옵트인 방식이며, 서브시스템이 이를 확인하지 않는 한 아무런 영향도 없습니다.

## 작동 방식

- 플래그는 문자열입니다(대소문자 구분 없음).
- 설정 또는 환경 변수 오버라이드를 통해 플래그를 활성화할 수 있습니다.
- 와일드카드를 지원합니다:
  - `telegram.*` 은 `telegram.http` 와 일치합니다
  - `*` 은 모든 플래그를 활성화합니다

## 설정을 통한 활성화

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

여러 플래그:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

플래그를 변경한 후 Gateway(게이트웨이)를 재시작하십시오.

## 환경 변수 오버라이드(일회성)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

모든 플래그 비활성화:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 로그 위치

플래그는 표준 진단 로그 파일로 로그를 기록합니다. 기본값은 다음과 같습니다:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file` 을 설정한 경우 해당 경로를 사용합니다. 로그는 JSONL 형식(한 줄당 하나의 JSON 객체)입니다. 마스킹은 `logging.redactSensitive` 에 따라 계속 적용됩니다.

## 로그 추출

최신 로그 파일 선택:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram HTTP 진단에 대해 필터링:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

또는 재현하면서 테일링:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

원격 Gateway(게이트웨이)의 경우 `openclaw logs --follow` 도 사용할 수 있습니다([/cli/logs](/cli/logs) 참조).

## 참고 사항

- `logging.level` 가 `warn` 보다 높게 설정되어 있으면 이러한 로그가 억제될 수 있습니다. 기본값 `info` 은 적절합니다.
- 플래그는 활성화된 상태로 두어도 안전하며, 특정 서브시스템의 로그 볼륨에만 영향을 미칩니다.
- 로그 대상, 레벨 및 마스킹을 변경하려면 [/logging](/logging) 을 사용하십시오.
