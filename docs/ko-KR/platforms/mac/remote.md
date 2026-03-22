---
summary: "SSH 를 통해 원격 OpenClaw Gateway 를 제어하기 위한 macOS 앱 흐름"
read_when:
  - 원격 Mac 제어를 설정하거나 디버깅할 때
title: "원격 제어"
x-i18n:
  source_path: docs/platforms/mac/remote.md
---

# 원격 OpenClaw (macOS ⇄ 원격 호스트)

이 흐름은 macOS 앱이 다른 호스트 (데스크톱/서버) 에서 실행 중인 OpenClaw Gateway 의 완전한 원격 제어 역할을 할 수 있게 합니다. 앱의 **Remote over SSH** (원격 실행) 기능입니다. 상태 확인, 음성 웨이크 전달, WebChat 등 모든 기능은 _설정 → 일반_ 에서 동일한 원격 SSH 설정을 재사용합니다.

## 모드

- **로컬 (이 Mac)**: 모든 것이 노트북에서 실행됩니다. SSH 가 관여하지 않습니다.
- **Remote over SSH (기본값)**: OpenClaw 명령이 원격 호스트에서 실행됩니다. Mac 앱은 `-o BatchMode` 와 선택한 아이덴티티/키 및 로컬 포트 포워드로 SSH 연결을 엽니다.
- **Remote direct (ws/wss)**: SSH 터널이 없습니다. Mac 앱이 Gateway URL 에 직접 연결합니다 (예: Tailscale Serve 또는 공개 HTTPS 리버스 프록시를 통해).

## 원격 전송 방식

원격 모드는 두 가지 전송 방식을 지원합니다:

- **SSH 터널** (기본값): `ssh -N -L ...` 을 사용하여 Gateway 포트를 localhost 로 포워딩합니다. 터널이 루프백이므로 Gateway 는 노드의 IP 를 `127.0.0.1` 로 인식합니다.
- **Direct (ws/wss)**: Gateway URL 에 직접 연결합니다. Gateway 가 실제 클라이언트 IP 를 인식합니다.

## 원격 호스트에서의 사전 요구 사항

1. Node + pnpm 을 설치하고 OpenClaw CLI 를 빌드/설치합니다 (`pnpm install && pnpm build && pnpm link --global`).
2. 비대화형 셸에서 `openclaw` 가 PATH 에 있는지 확인합니다 (필요시 `/usr/local/bin` 또는 `/opt/homebrew/bin` 에 심볼릭 링크).
3. 키 인증으로 SSH 를 엽니다. LAN 외부에서 안정적인 접근을 위해 **Tailscale** IP 를 권장합니다.

## macOS 앱 설정

1. _설정 → 일반_ 을 엽니다.
2. **OpenClaw 실행 위치** 에서 **Remote over SSH** 를 선택하고 설정합니다:
   - **전송 방식**: **SSH 터널** 또는 **Direct (ws/wss)**.
   - **SSH 대상**: `user@host` (선택적 `:port`).
     - Gateway 가 동일 LAN 에 있고 Bonjour 를 광고하면, 검색된 목록에서 선택하여 이 필드를 자동 채웁니다.
   - **Gateway URL** (Direct 전용): `wss://gateway.example.ts.net` (또는 로컬/LAN 의 경우 `ws://...`).
   - **아이덴티티 파일** (고급): 키 경로.
   - **프로젝트 루트** (고급): 명령에 사용되는 원격 체크아웃 경로.
   - **CLI 경로** (고급): 실행 가능한 `openclaw` 엔트리포인트/바이너리의 선택적 경로 (광고 시 자동 채움).
3. **원격 테스트** 를 누릅니다. 성공은 원격 `openclaw status --json` 이 올바르게 실행됨을 나타냅니다. 실패는 보통 PATH/CLI 문제를 의미합니다; exit 127 은 CLI 가 원격에서 찾을 수 없음을 의미합니다.
4. 상태 확인과 WebChat 이 이제 이 SSH 터널을 통해 자동으로 실행됩니다.

## WebChat

- **SSH 터널**: WebChat 이 포워딩된 WebSocket 제어 포트 (기본값 18789) 를 통해 Gateway 에 연결합니다.
- **Direct (ws/wss)**: WebChat 이 설정된 Gateway URL 에 직접 연결합니다.
- 별도의 WebChat HTTP 서버는 더 이상 없습니다.

## 권한

- 원격 호스트는 로컬과 동일한 TCC 승인이 필요합니다 (자동화, 접근성, 화면 녹화, 마이크, 음성 인식, 알림). 해당 머신에서 온보딩을 실행하여 한 번 부여하세요.
- 노드는 `node.list` / `node.describe` 를 통해 권한 상태를 광고하여 에이전트가 사용 가능한 것을 알 수 있습니다.

## 보안 참고

- 원격 호스트에서 루프백 바인드를 선호하고 SSH 또는 Tailscale 을 통해 연결합니다.
- SSH 터널링은 엄격한 호스트 키 확인을 사용합니다; `~/.ssh/known_hosts` 에 호스트 키가 존재하도록 먼저 신뢰하세요.
- Gateway 를 비루프백 인터페이스에 바인드하는 경우, 토큰/비밀번호 인증을 요구하세요.
- [보안](/gateway/security) 및 [Tailscale](/gateway/tailscale) 을 참조하세요.

## WhatsApp 로그인 흐름 (원격)

- **원격 호스트에서** `openclaw channels login --verbose` 를 실행합니다. 휴대폰의 WhatsApp 으로 QR 을 스캔합니다.
- 인증이 만료되면 해당 호스트에서 로그인을 다시 실행합니다. 상태 확인이 링크 문제를 표시합니다.

## 문제 해결

- **exit 127 / not found**: `openclaw` 이 비로그인 셸의 PATH 에 없습니다. `/etc/paths`, 셸 rc 에 추가하거나 `/usr/local/bin`/`/opt/homebrew/bin` 에 심볼릭 링크하세요.
- **상태 프로브 실패**: SSH 접근성, PATH, Baileys 로그인 여부를 확인합니다 (`openclaw status --json`).
- **WebChat 멈춤**: 원격 호스트에서 Gateway 가 실행 중이고 포워딩된 포트가 Gateway WS 포트와 일치하는지 확인합니다; UI 는 정상적인 WS 연결이 필요합니다.
- **노드 IP 가 127.0.0.1 로 표시**: SSH 터널에서는 예상되는 결과입니다. Gateway 가 실제 클라이언트 IP 를 인식하길 원하면 **전송 방식**을 **Direct (ws/wss)** 로 전환하세요.
- **음성 웨이크**: 트리거 구문이 원격 모드에서 자동으로 전달됩니다; 별도의 전달기가 필요하지 않습니다.

## 알림 소리

스크립트에서 `openclaw` 과 `node.invoke` 로 알림별 소리를 선택합니다, 예:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

앱에 전역 "기본 소리" 토글이 더 이상 없습니다; 호출자가 요청별로 소리 (또는 없음) 를 선택합니다.
