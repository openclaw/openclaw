---
read_when:
    - OpenClaw.app에서 PeekabooBridge 호스팅
    - Swift Package Manager를 통해 Peekaboo 통합
    - PeekabooBridge 프로토콜/경로 변경
summary: macOS UI 자동화를 위한 PeekabooBridge 통합
title: 까꿍 다리
x-i18n:
    generated_at: "2026-02-08T16:08:21Z"
    model: gtx
    provider: google-translate
    source_hash: b5b9ddb9a7c59e153a1d5d23c33616bb1542b5c7dadedc3af340aeee9ba03487
    source_path: platforms/mac/peekaboo.md
    workflow: 15
---

# Peekaboo Bridge(macOS UI 자동화)

OpenClaw는 호스팅 가능 **까꿍다리** 로컬 권한 인식 UI 자동화
브로커. 이를 통해 `peekaboo` 재사용하는 동안 CLI 드라이브 UI 자동화
macOS 앱의 TCC 권한.

## 이것이 무엇인지 (그리고 아닌지)

- **주인**: OpenClaw.app은 PeekabooBridge 호스트 역할을 할 수 있습니다.
- **고객**: 사용하다 `peekaboo` CLI(별도 없음 `openclaw ui ...` 표면).
- **UI**: 시각적 오버레이는 Peekaboo.app에 유지됩니다. OpenClaw는 씬 브로커 호스트입니다.

## 브리지 활성화

macOS 앱에서:

- 설정 → **피카부 브릿지 활성화**

활성화되면 OpenClaw는 로컬 UNIX 소켓 서버를 시작합니다. 비활성화된 경우 호스트는
정지되고 `peekaboo` 사용 가능한 다른 호스트로 대체됩니다.

## 클라이언트 검색 순서

Peekaboo 클라이언트는 일반적으로 다음 순서로 호스트를 시도합니다.

1. Peekaboo.app(전체 UX)
2. Claude.app(설치된 경우)
3. OpenClaw.app(씬 브로커)

사용 `peekaboo bridge status --verbose` 어떤 호스트가 활성화되어 있고 어떤 호스트가 활성화되어 있는지 확인하려면
소켓 경로가 사용 중입니다. 다음을 사용하여 재정의할 수 있습니다.

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## 보안 및 권한

- 브릿지가 검증한다 **발신자 코드 서명**; TeamID의 허용 목록은 다음과 같습니다.
  시행됩니다(Peekaboo 호스트 TeamID + OpenClaw 앱 TeamID).
- ~10초 후에 시간 초과를 요청합니다.
- 필요한 권한이 누락된 경우 브리지는 명확한 오류 메시지를 반환합니다.
  시스템 설정을 실행하는 대신

## 스냅샷 동작(자동화)

스냅샷은 메모리에 저장되며 짧은 기간이 지나면 자동으로 만료됩니다.
더 긴 보존이 필요한 경우 클라이언트에서 다시 캡처하세요.

## 문제 해결

- 만약에 `peekaboo` "브리지 클라이언트가 승인되지 않았습니다"라고 보고하고 클라이언트가 승인되었는지 확인하세요.
  올바르게 서명하거나 호스트를 실행하십시오. `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`
  ~에 **디버그** 모드 전용.
- 호스트를 찾을 수 없으면 호스트 앱(Peekaboo.app 또는 OpenClaw.app) 중 하나를 엽니다.
  권한이 부여되었는지 확인하세요.
