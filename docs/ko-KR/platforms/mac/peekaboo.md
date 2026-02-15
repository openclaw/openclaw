---
summary: "PeekabooBridge integration for macOS UI automation"
read_when:
  - Hosting PeekabooBridge in OpenClaw.app
  - Integrating Peekaboo via Swift Package Manager
  - Changing PeekabooBridge protocol/paths
title: "Peekaboo Bridge"
x-i18n:
  source_hash: b5b9ddb9a7c59e153a1d5d23c33616bb1542b5c7dadedc3af340aeee9ba03487
---

# 피카부 브릿지(macOS UI 자동화)

OpenClaw는 **PeekabooBridge**를 로컬 권한 인식 UI 자동화로 호스팅할 수 있습니다.
브로커. 이를 통해 `peekaboo` CLI가 UI 자동화를 재사용하는 동안
macOS 앱의 TCC 권한.

## 이것이 무엇인지(그리고 아닌지)

- **호스트**: OpenClaw.app은 PeekabooBridge 호스트 역할을 할 수 있습니다.
- **클라이언트**: `peekaboo` CLI를 사용합니다(별도의 `openclaw ui ...` 표면 없음).
- **UI**: 시각적 오버레이는 Peekaboo.app에 유지됩니다. OpenClaw는 씬 브로커 호스트입니다.

## 브리지 활성화

macOS 앱에서:

- 설정 → **피카부 브릿지 활성화**

활성화되면 OpenClaw는 로컬 UNIX 소켓 서버를 시작합니다. 비활성화된 경우 호스트는
중지되고 `peekaboo`는 사용 가능한 다른 호스트로 대체됩니다.

## 클라이언트 검색 순서

Peekaboo 클라이언트는 일반적으로 다음 순서로 호스트를 시도합니다.

1. Peekaboo.app(풀 UX)
2. Claude.app(설치된 경우)
3. OpenClaw.app(씬 브로커)

`peekaboo bridge status --verbose`를 사용하여 어떤 호스트가 활성화되어 있는지 확인하세요.
소켓 경로가 사용 중입니다. 다음을 사용하여 재정의할 수 있습니다.

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## 보안 및 권한

- 브리지는 **발신자 코드 서명**을 검증합니다. TeamID의 허용 목록은 다음과 같습니다.
  시행됩니다(Peekaboo 호스트 TeamID + OpenClaw 앱 TeamID).
- ~10초 후에 타임아웃을 요청합니다.
- 필요한 권한이 누락된 경우 브리지는 명확한 오류 메시지를 반환합니다.
  시스템 설정을 실행하는 대신

## 스냅샷 동작(자동화)

스냅샷은 메모리에 저장되며 짧은 기간이 지나면 자동으로 만료됩니다.
더 긴 보존이 필요한 경우 클라이언트에서 다시 캡처하세요.

## 문제 해결

- `peekaboo`가 "브리지 클라이언트가 인증되지 않았습니다"라고 보고하는 경우 클라이언트가 인증되었는지 확인하세요.
  `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`를 사용하여 올바르게 서명하거나 호스트를 실행하십시오.
  **디버그** 모드에서만 가능합니다.
- 호스트를 찾을 수 없으면 호스트 앱(Peekaboo.app 또는 OpenClaw.app) 중 하나를 엽니다.
  권한이 부여되었는지 확인하세요.
