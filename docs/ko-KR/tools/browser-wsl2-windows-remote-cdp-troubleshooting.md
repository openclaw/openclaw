---
summary: "WSL2 Gateway + Windows Chrome 원격 CDP 를 레이어별로 문제 해결"
read_when:
  - Chrome 이 Windows 에 있으면서 WSL2 에서 OpenClaw Gateway 를 실행할 때
  - WSL2 와 Windows 에 걸쳐 겹치는 브라우저/컨트롤 UI 오류를 볼 때
  - 분할 호스트 설정에서 호스트 로컬 Chrome MCP 와 원시 원격 CDP 사이에서 결정할 때
title: "WSL2 + Windows + 원격 Chrome CDP 문제 해결"
x-i18n:
  source_path: docs/tools/browser-wsl2-windows-remote-cdp-troubleshooting.md
---

# WSL2 + Windows + 원격 Chrome CDP 문제 해결

이 가이드는 다음과 같은 일반적인 분할 호스트 설정을 다룹니다:

- OpenClaw Gateway 가 WSL2 내에서 실행
- Chrome 이 Windows 에서 실행
- 브라우저 제어가 WSL2/Windows 경계를 넘어야 함

[이슈 #39369](https://github.com/openclaw/openclaw/issues/39369) 에서의 계층적 실패 패턴도 다룹니다: 여러 독립적인 문제가 한 번에 나타날 수 있어 잘못된 레이어가 먼저 고장 난 것처럼 보입니다.

## 먼저 올바른 브라우저 모드 선택

두 가지 유효한 패턴이 있습니다:

### 옵션 1: WSL2 에서 Windows 로의 원시 원격 CDP

WSL2 에서 Windows Chrome CDP 엔드포인트를 가리키는 원격 브라우저 프로필을 사용합니다.

다음 경우에 선택:

- Gateway 가 WSL2 내에 유지
- Chrome 이 Windows 에서 실행
- 브라우저 제어가 WSL2/Windows 경계를 넘어야 함

### 옵션 2: 호스트 로컬 Chrome MCP

Gateway 자체가 Chrome 과 같은 호스트에서 실행될 때만 `existing-session` / `user`를 사용합니다.

다음 경우에 선택:

- OpenClaw 과 Chrome 이 같은 머신에 있음
- 로컬 로그인된 브라우저 상태를 원함
- 크로스 호스트 브라우저 전송이 필요하지 않음

WSL2 Gateway + Windows Chrome 의 경우 원시 원격 CDP 를 선호합니다. Chrome MCP 는 호스트 로컬이며 WSL2-Windows 브리지가 아닙니다.

## 레이어별 유효성 검사

위에서 아래로 작업합니다. 건너뛰지 마세요.

### 레이어 1: Windows 에서 Chrome 이 CDP 를 제공하는지 확인

Windows 에서 원격 디버깅을 활성화한 Chrome 을 시작합니다:

```powershell
chrome.exe --remote-debugging-port=9222
```

Windows 에서 먼저 Chrome 자체를 확인합니다:

```powershell
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

이것이 Windows 에서 실패하면 아직 OpenClaw 문제가 아닙니다.

### 레이어 2: WSL2 에서 해당 Windows 엔드포인트에 도달할 수 있는지 확인

WSL2 에서 `cdpUrl`에 사용할 정확한 주소를 테스트합니다:

```bash
curl http://WINDOWS_HOST_OR_IP:9222/json/version
curl http://WINDOWS_HOST_OR_IP:9222/json/list
```

이것이 실패하면:

- Windows 가 아직 WSL2 에 포트를 노출하지 않음
- WSL2 측의 주소가 잘못됨
- 방화벽 / 포트 포워딩 / 로컬 프록시가 아직 누락됨

OpenClaw 설정을 건드리기 전에 이것을 수정하세요.

### 레이어 3: 올바른 브라우저 프로필 구성

원시 원격 CDP 의 경우 WSL2 에서 도달 가능한 주소로 OpenClaw 을 가리킵니다:

```json5
{
  browser: {
    enabled: true,
    defaultProfile: "remote",
    profiles: {
      remote: {
        cdpUrl: "http://WINDOWS_HOST_OR_IP:9222",
        attachOnly: true,
        color: "#00AA00",
      },
    },
  },
}
```

### 레이어 4: Control UI 레이어를 별도로 확인

Windows 에서 UI 를 엽니다:

`http://127.0.0.1:18789/`

### 레이어 5: 엔드투엔드 브라우저 제어 확인

WSL2 에서:

```bash
openclaw browser open https://example.com --browser-profile remote
openclaw browser tabs --browser-profile remote
```

## 빠른 분류 체크리스트

1. Windows: `curl http://127.0.0.1:9222/json/version`가 작동하나요?
2. WSL2: `curl http://WINDOWS_HOST_OR_IP:9222/json/version`가 작동하나요?
3. OpenClaw 설정: `browser.profiles.<name>.cdpUrl`이 정확한 WSL2 도달 가능 주소를 사용하나요?
4. Control UI: LAN IP 대신 `http://127.0.0.1:18789/`를 열고 있나요?
5. 원시 원격 CDP 대신 WSL2 와 Windows 에 걸쳐 `existing-session`을 사용하려고 하고 있나요?

## 실용적 결론

이 설정은 보통 가능합니다. 어려운 부분은 브라우저 전송, Control UI 원본 보안 및 토큰/페어링이 각각 독립적으로 실패할 수 있으면서 사용자 측에서 비슷하게 보인다는 것입니다.

의심스러울 때:

- 먼저 Windows Chrome 엔드포인트를 로컬에서 확인
- 두 번째로 WSL2 에서 동일한 엔드포인트를 확인
- 그 다음에야 OpenClaw 설정 또는 Control UI 인증을 디버깅
