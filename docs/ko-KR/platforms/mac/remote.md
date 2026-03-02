---
summary: "원격 OpenClaw gateway를 SSH를 통해 제어하기 위한 macOS 앱 흐름"
read_when:
  - 원격 mac 제어를 설정하거나 디버깅할 때
title: "원격 제어"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
  source_path: "docs/platforms/mac/remote.md"
  workflow: 15
---

# 원격 OpenClaw (macOS ⇄ 원격 호스트)

이 흐름은 macOS 앱이 다른 호스트 (데스크톱/서버)에서 실행 중인 OpenClaw gateway의 전체 원격 제어로 작동하도록 합니다. 이것은 앱의 **Remote over SSH** (원격 실행) 기능입니다. 모든 기능—헬스 체크, Voice Wake 포워딩, 그리고 Web Chat—은 *Settings → General*의 동일한 원격 SSH 구성을 재사용합니다.

## 모드

- **Local (이 Mac)**: 모든 것이 노트북에서 실행됩니다. SSH 관련 없음.
- **Remote over SSH (기본값)**: OpenClaw 명령어는 원격 호스트에서 실행됩니다. mac 앱은 `-o BatchMode` plus 선택한 항등성/키와 로컬 포트 포워드를 사용하여 SSH 연결을 엽니다.
- **Remote direct (ws/wss)**: SSH 터널 없음. mac 앱은 gateway URL에 직접 연결합니다 (예: Tailscale Serve 또는 공개 HTTPS 역 프록시를 통해).

## 원격 전송

원격 모드는 두 전송을 지원합니다:

- **SSH 터널** (기본값): `ssh -N -L ...`을 사용하여 gateway 포트를 localhost로 포워드합니다. gateway는 터널이 loopback이므로 노드의 IP를 `127.0.0.1`로 봅니다.
- **Direct (ws/wss)**: gateway URL에 직접 연결합니다. gateway는 실제 클라이언트 IP를 봅니다.

## 원격 호스트의 전제 조건

1. Node + pnpm을 설치하고 OpenClaw CLI를 빌드/설치합니다 (`pnpm install && pnpm build && pnpm link --global`).
2. `openclaw`이 비대화형 셸에 대해 PATH에 있는지 확인합니다 (필요한 경우 `/usr/local/bin` 또는 `/opt/homebrew/bin`으로 심볼릭 링크).
3. SSH를 키 인증으로 엽니다. 우리는 **Tailscale** IP를 LAN 밖의 안정적인 도달 가능성을 위해 권장합니다.

## macOS 앱 설정

1. *Settings → General*을 엽니다.
2. **OpenClaw runs** 아래에서, **Remote over SSH**를 선택하고 다음을 설정합니다:
   - **Transport**: **SSH tunnel** 또는 **Direct (ws/wss)**.
   - **SSH target**: `user@host` (선택 사항 `:port`).
     - gateway가 같은 LAN에 있고 Bonjour를 광고하면, 이 필드를 자동 채우기 위해 발견된 목록에서 선택합니다.
   - **Gateway URL** (Direct only): `wss://gateway.example.ts.net` (또는 로컬/LAN의 경우 `ws://...`).
   - **Identity file** (advanced): 키에 대한 경로.
   - **Project root** (advanced): 명령어에 사용되는 원격 체크아웃 경로.
   - **CLI path** (advanced): 실행 가능한 `openclaw` entrypoint/바이너리 (광고될 때 자동 채워짐)의 선택적 경로.
3. **Test remote**를 누릅니다. 성공은 원격 `openclaw status --json`이 올바르게 실행됨을 나타냅니다. 실패는 일반적으로 PATH/CLI 문제를 의미합니다. exit 127은 CLI를 원격으로 찾을 수 없음을 의미합니다.
4. 헬스 체크 및 Web Chat이 이제 이 SSH 터널을 통해 자동으로 실행됩니다.

## Web Chat

- **SSH 터널**: Web Chat은 포워드된 WebSocket 제어 포트 (기본값 18789)를 통해 gateway에 연결합니다.
- **Direct (ws/wss)**: Web Chat은 구성된 gateway URL로 직접 연결합니다.
- 별도의 WebChat HTTP 서버는 더 이상 없습니다.

## 권한

- 원격 호스트는 로컬과 동일한 TCC 승인이 필요합니다 (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). 해당 머신에서 온보딩을 한 번 실행하여 부여합니다.
- 노드는 `node.list` / `node.describe`를 통해 권한 상태를 광고하므로 에이전트는 사용 가능한 항목을 알 수 있습니다.

## 보안 참고 사항

- 원격 호스트에서 loopback 바인드를 선호하고 SSH 또는 Tailscale을 통해 연결합니다.
- SSH 터널링은 엄격한 호스트 키 확인을 사용합니다. 호스트 키를 먼저 신뢰하여 `~/.ssh/known_hosts`에 존재하도록 합니다.
- Gateway를 비-loopback 인터페이스에 바인드하면, 토큰/암호 인증이 필요합니다.
- [Security](/gateway/security) 및 [Tailscale](/gateway/tailscale)을 참조합니다.

## WhatsApp 로그인 흐름 (원격)

- **원격 호스트에서** `openclaw channels login --verbose`을 실행합니다. WhatsApp으로 스캔 QR을 사용하여 휴대폰에서 입력합니다.
- auth가 만료되면 해당 호스트에서 로그인을 다시 실행합니다. 헬스 체크가 링크 문제를 표시합니다.

## 문제 해결

- **exit 127 / not found**: `openclaw`이 비-로그인 셸에 대해 PATH에 없습니다. `/etc/paths`, 셸 rc, 또는 `/usr/local/bin`/`/opt/homebrew/bin`에 심볼릭 링크에 추가합니다.
- **Health probe failed**: SSH 도달 가능성, PATH, 그리고 Baileys가 로그인되어 있는지 확인합니다 (`openclaw status --json`).
- **Web Chat stuck**: gateway가 원격 호스트에서 실행 중인지, 그리고 포워드된 포트가 gateway WS 포트와 일치하는지 확인합니다. UI는 건강한 WS 연결이 필요합니다.
- **Node IP shows 127.0.0.1**: SSH 터널과 예상됨. gateway가 실제 클라이언트 IP를 보기를 원하면 **Transport**를 **Direct (ws/wss)**로 전환합니다.
- **Voice Wake**: 트리거 구문은 원격 모드에서 자동으로 포워드됩니다. 별도의 포워더가 필요하지 않습니다.

## 알림 음

스크립트에서 `openclaw` 및 `node.invoke`를 사용하여 알림별로 음을 선택합니다. 예:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

더 이상 앱의 전역 "default sound" 토글이 없습니다. 호출자는 요청별로 음을 선택합니다 (또는 없음).
