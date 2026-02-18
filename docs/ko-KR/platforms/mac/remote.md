---
summary: "SSH를 통해 원격 OpenClaw 게이트웨이를 제어하는 macOS 앱 흐름"
read_when:
  - 원격 mac 제어 설정 또는 디버깅
title: "원격 제어"
---

# Remote OpenClaw (macOS ⇄ 원격 호스트)

이 흐름은 macOS 앱이 다른 호스트(데스크탑/서버)에서 실행 중인 OpenClaw 게이트웨이의 전체 원격 제어 역할을 하게 합니다. 이는 앱의 **SSH를 통한 원격 제어**(원격 실행) 기능입니다. 모든 기능—상태 검사, Voice Wake 포워딩, Web Chat—이 *설정 → 일반*에서 동일한 원격 SSH 구성을 재사용합니다.

## 모드

- **로컬(이 Mac)**: 모든 것이 노트북에서 실행됩니다. SSH는 포함되지 않습니다.
- **SSH를 통한 원격(default)**: OpenClaw 명령어가 원격 호스트에서 실행됩니다. Mac 앱은 `-o BatchMode`와 선택한 ID/키, 로컬 포트 포워드를 사용하여 SSH 연결을 엽니다.
- **직접 원격(ws/wss)**: SSH 터널이 없습니다. Mac 앱은 Tailscale Serve나 공용 HTTPS 역방향 프록시를 통해 게이트웨이 URL에 직접 연결합니다.

## 원격 전송 프로토콜

원격 모드는 두 가지 전송 프로토콜을 지원합니다:

- **SSH 터널(default)**: 게이트웨이 포트를 localhost로 포워드하기 위해 `ssh -N -L ...`을 사용합니다. 터널은 로컬 루프백이므로 게이트웨이는 노드의 IP를 `127.0.0.1`로 인식합니다.
- **직접(ws/wss)**: 게이트웨이 URL에 직접 연결됩니다. 게이트웨이는 실제 클라이언트 IP를 인식합니다.

## 원격 호스트의 사전 요구사항

1. Node 및 pnpm을 설치하고 OpenClaw CLI를 빌드/설치합니다. (`pnpm install && pnpm build && pnpm link --global`)
2. 비대화형 셸에서 PATH에 `openclaw`가 있는지 확인합니다. 필요하면 `/usr/local/bin` 또는 `/opt/homebrew/bin`에 심볼릭 링크를 만드십시오.
3. 키 인증을 사용하여 SSH를 엽니다. 안정적인 비LAN 접근성을 위해 **Tailscale** IP를 권장합니다.

## macOS 앱 설정

1. *설정 → 일반*을 엽니다.
2. **OpenClaw 실행** 아래에서 **SSH를 통한 원격**을 선택하고 다음을 설정합니다:
   - **전송 방법**: **SSH 터널** 또는 **직접(ws/wss)**.
   - **SSH 대상**: `user@host` (선택적으로 `:port` 추가).
     - 게이트웨이가 동일한 LAN에 있고 Bonjour를 광고하는 경우, 발견된 목록에서 자동 완성을 위해 선택하십시오.
   - **게이트웨이 URL** (직접 전용): `wss://gateway.example.ts.net` (`ws://...` 로컬/LAN의 경우).
   - **신원 파일** (고급): 키 경로.
   - **프로젝트 루트** (고급): 명령어에 사용되는 원격 체크아웃 경로.
   - **CLI 경로** (고급): 실행 가능한 `openclaw` 진입점/바이너리의 선택적 경로 (광고될 때 자동 완료).
3. **원격 테스트**를 클릭합니다. 성공은 원격에서 `openclaw status --json`이 올바르게 실행됨을 나타냅니다. 실패는 보통 PATH/CLI 문제를 의미합니다. 127 종료 코드는 CLI가 원격에서 발견되지 않음을 의미합니다.
4. 상태 검사 및 Web Chat은 이제 이 SSH 터널을 통해 자동으로 실행됩니다.

## Web Chat

- **SSH 터널**: Web Chat은 전달된 WebSocket 제어 포트(기본 18789)를 통해 게이트웨이에 연결됩니다.
- **직접(ws/wss)**: Web Chat은 구성된 게이트웨이 URL에 직접 연결됩니다.
- 별도의 WebChat HTTP 서버는 더 이상 존재하지 않습니다.

## 권한

- 원격 호스트는 로컬과 동일한 TCC 승인(자동화, 보조 기술, 화면 녹화, 마이크, 음성 인식, 알림)이 필요합니다. 해당 기기에서 온보딩을 실행하여 한 번 권한을 부여하십시오.
- 노드는 그들의 권한 상태를 `node.list` / `node.describe`를 통해 광고하여 에이전트가 사용 가능성을 알 수 있습니다.

## 보안 주의사항

- 원격 호스트에서는 로컬 루프백 바인드를 선호하고 SSH 또는 Tailscale을 통해 연결합니다.
- 게이트웨이를 비 루프백 인터페이스에 바인딩할 경우 토큰/비밀번호 인증을 요구합니다.
- [보안](/gateway/security) 및 [Tailscale](/gateway/tailscale)을 참조하십시오.

## WhatsApp 로그인 흐름 (원격)

- **원격 호스트에서** `openclaw channels login --verbose`를 실행합니다. 휴대폰의 WhatsApp으로 QR을 스캔합니다.
- 인증이 만료되면 그 호스트에서 로그인을 다시 실행합니다. 상태 검사가 링크 문제를 표면화할 것입니다.

## 문제 해결

- **127로 종료 / 발견되지 않음**: `openclaw`가 비로그인 셸에 대한 PATH에 없습니다. `/etc/paths`, 셸 rc에 추가하거나 `/usr/local/bin`/`/opt/homebrew/bin`에 심볼릭 링크하십시오.
- **상태 프로브 실패**: SSH 접근성, PATH, Baileys가 로그인되었는지 (`openclaw status --json`) 확인하십시오.
- **Web Chat 멈춤**: 게이트웨이가 원격 호스트에서 실행 중인지 확인하고 포워드된 포트가 게이트웨이 WS 포트와 일치하는지 확인하십시오. UI는 안정적인 WS 연결을 요구합니다.
- **노드 IP가 127.0.0.1로 표시됨**: SSH 터널에서는 예상된 사항입니다. 게이트웨이가 실제 클라이언트 IP를 보길 원하면 **전송 방법**을 **직접(ws/wss)** 로 전환하십시오.
- **Voice Wake**: 트리거 구문은 원격 모드에서 자동으로 포워딩되며 별도의 포워더가 필요하지 않습니다.

## 알림 소리

`scripts`와 `openclaw`, `node.invoke`를 사용하여 알림별로 소리를 선택하십시오. 예를 들어:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

앱에 더 이상 글로벌 “기본 소리” 토글은 없습니다. 호출자는 요청별로 소리(또는 없음)를 선택합니다.
