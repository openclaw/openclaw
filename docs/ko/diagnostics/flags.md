---
read_when:
    - 전역 로깅 수준을 높이지 않고 대상 디버그 로그가 필요합니다.
    - 지원을 위해 하위 시스템별 로그를 캡처해야 합니다.
summary: 대상 디버그 로그에 대한 진단 플래그
title: 진단 플래그
x-i18n:
    generated_at: "2026-02-08T15:56:04Z"
    model: gtx
    provider: google-translate
    source_hash: daf0eca0e6bd1cbc2c400b2e94e1698709a96b9cdba1a8cf00bd580a61829124
    source_path: diagnostics/flags.md
    workflow: 15
---

# 진단 플래그

진단 플래그를 사용하면 어디에서나 자세한 로깅을 활성화하지 않고도 대상 디버그 로그를 활성화할 수 있습니다. 플래그는 선택 사항이며 하위 시스템에서 확인하지 않는 한 아무런 효과가 없습니다.

## 작동 원리

- 플래그는 문자열입니다(대소문자를 구분하지 않음).
- 구성이나 환경 재정의를 통해 플래그를 활성화할 수 있습니다.
- 와일드카드가 지원됩니다:
  - `telegram.*` 성냥 `telegram.http`
  - `*` 모든 플래그를 활성화합니다

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

설정하면 `logging.file`, 대신 해당 경로를 사용하세요. 로그는 JSONL(한 줄에 하나의 JSON 개체)입니다. 다음을 기준으로 수정이 계속 적용됩니다. `logging.redactSensitive`.

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

원격 게이트웨이의 경우 다음을 사용할 수도 있습니다. `openclaw logs --follow` (보다 [/cli/로그](/cli/logs)).

## 메모

- 만약에 `logging.level` 보다 높게 설정되어 있습니다 `warn`, 이러한 로그는 표시되지 않을 수 있습니다. 기본 `info` 괜찮아요.
- 플래그는 활성화된 상태로 두어도 안전합니다. 특정 하위 시스템의 로그 볼륨에만 영향을 미칩니다.
- 사용 [/벌채 반출](/logging) 로그 대상, 수준 및 수정을 변경합니다.
