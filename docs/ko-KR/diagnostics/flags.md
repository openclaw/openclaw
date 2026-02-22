---
summary: "대상 디버그 로그를 위한 진단 플래그"
read_when:
  - 전역 로그 수준을 높이지 않고 대상 디버그 로그가 필요할 때
  - 지원을 위한 하위 시스템별 로그를 캡처해야 할 때
title: "진단 플래그"
---

# 진단 플래그

진단 플래그를 사용하면 번거로운 로그를 전역적으로 활성화하지 않고 특정 디버그 로그를 활성화할 수 있습니다. 플래그는 선택적인 것이며 하위 시스템이 플래그를 확인하지 않는 한 영향이 없습니다.

## 작동 방식

- 플래그는 문자열입니다(대소문자 구분 없음).
- 설정에서 또는 환경 변수 오버라이드를 통해 플래그를 활성화할 수 있습니다.
- 와일드카드가 지원됩니다:
  - `telegram.*`은 `telegram.http`에 해당합니다.
  - `*`은 모든 플래그를 활성화합니다.

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

플래그를 변경한 후 게이트웨이를 재시작하십시오.

## 환경 변수 오버라이드 (일회성)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

모든 플래그 비활성화:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 로그 저장 위치

플래그는 표준 진단 로그 파일에 로그를 기록합니다. 기본 경로는 다음과 같습니다:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file`을 설정했다면 그 경로를 사용하십시오. 로그는 JSONL 형식입니다 (줄당 하나의 JSON 객체). `logging.redactSensitive`에 기반하여 민감한 정보의 수정이 계속 적용됩니다.

## 로그 추출

최신 로그 파일 선택:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram HTTP 진단 필터링:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

재현 중 실시간 로그 보기:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

원격 게이트웨이의 경우 `openclaw logs --follow`를 사용할 수도 있습니다 (자세한 내용은 [/cli/logs](/cli/logs) 참조).

## 참고 사항

- `logging.level`이 `warn`보다 높게 설정되어 있으면 이러한 로그가 억제될 수 있습니다. 기본 `info`면 괜찮습니다.
- 플래그는 계속 활성화해도 안전합니다; 특정 하위 시스템의 로그 볼륨에만 영향을 줍니다.
- 로그 목적지, 수준 및 수정 변경은 [/logging](/logging)을 참조하십시오.
