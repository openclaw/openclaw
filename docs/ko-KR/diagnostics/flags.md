---
summary: "Diagnostics flags for targeted debug logs"
read_when:
  - You need targeted debug logs without raising global logging levels
  - You need to capture subsystem-specific logs for support
title: "Diagnostics Flags"
x-i18n:
  source_hash: daf0eca0e6bd1cbc2c400b2e94e1698709a96b9cdba1a8cf00bd580a61829124
---

# 진단 플래그

진단 플래그를 사용하면 어디에서나 자세한 로깅을 활성화하지 않고도 대상 디버그 로그를 활성화할 수 있습니다. 플래그는 선택 사항이며 하위 시스템에서 확인하지 않는 한 아무런 효과가 없습니다.

## 작동 방식

- 플래그는 문자열입니다(대소문자를 구분하지 않음).
- 구성이나 환경 재정의를 통해 플래그를 활성화할 수 있습니다.
- 와일드카드가 지원됩니다:
  - `telegram.*`는 `telegram.http`와 일치합니다.
  - `*` 모든 플래그를 활성화합니다.

## 구성을 통해 활성화

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

다중 플래그:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

플래그를 변경한 후 게이트웨이를 다시 시작하십시오.

## 환경 재정의(일회성)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

모든 플래그를 비활성화합니다.

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 로그는 어디로 가는가

플래그는 표준 진단 로그 파일에 로그를 내보냅니다. 기본적으로:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

`logging.file`를 설정한 경우 해당 경로를 대신 사용하세요. 로그는 JSONL(한 줄에 하나의 JSON 개체)입니다. `logging.redactSensitive`에 따라 수정이 계속 적용됩니다.

## 로그 추출

최신 로그 파일을 선택하세요.

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Telegram HTTP 진단을 위한 필터:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

또는 재생산하는 동안 꼬리:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

원격 게이트웨이의 경우 `openclaw logs --follow`를 사용할 수도 있습니다([/cli/logs](/cli/logs) 참조).

## 메모

- `logging.level`가 `warn`보다 높게 설정되면 해당 로그가 표시되지 않을 수 있습니다. 기본값 `info`은 괜찮습니다.
- 플래그는 활성화된 상태로 두어도 안전합니다. 특정 하위 시스템의 로그 볼륨에만 영향을 미칩니다.
- 로그 대상, 레벨, 편집을 변경하려면 [/logging](/logging)을 사용하세요.
