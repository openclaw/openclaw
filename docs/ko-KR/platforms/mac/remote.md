---
summary: "macOS app flow for controlling a remote OpenClaw gateway over SSH"
read_when:
  - Setting up or debugging remote mac control
title: "Remote Control"
x-i18n:
  source_hash: 61b43707250d5515fd0f85f092bdde24598f14904398ff3fca3736bcc48d72f8
---

# 원격 OpenClaw(macOS ⇄ 원격 호스트)

이 흐름을 통해 macOS 앱은 다른 호스트(데스크톱/서버)에서 실행되는 OpenClaw 게이트웨이에 대한 완전한 원격 제어 역할을 할 수 있습니다. 앱의 **Remote over SSH**(원격 실행) 기능입니다. 상태 확인, 음성 깨우기 전달, 웹 채팅 등 모든 기능은 *설정 → 일반*에서 동일한 원격 SSH 구성을 재사용합니다.

## 모드

- **로컬(이 Mac)**: 모든 것이 노트북에서 실행됩니다. SSH가 포함되지 않았습니다.
- **SSH를 통한 원격(기본값)**: OpenClaw 명령이 원격 호스트에서 실행됩니다. Mac 앱은 `-o BatchMode`와 선택한 ID/키 및 로컬 포트 ​​전달을 사용하여 SSH 연결을 엽니다.
- **원격 직접(ws/wss)**: SSH 터널이 없습니다. Mac 앱은 게이트웨이 URL에 직접 연결됩니다(예: Tailscale Serve 또는 공용 HTTPS 역방향 프록시를 통해).

## 원격 전송

원격 모드는 두 가지 전송을 지원합니다.

- **SSH 터널**(기본값): `ssh -N -L ...`를 사용하여 게이트웨이 포트를 localhost로 전달합니다. 터널이 루프백이므로 게이트웨이는 노드의 IP를 `127.0.0.1`로 표시합니다.
- **직접(ws/wss)**: 게이트웨이 URL로 바로 연결합니다. 게이트웨이는 실제 클라이언트 IP를 봅니다.

## 원격 호스트의 전제조건

1. Node + pnpm을 설치하고 OpenClaw CLI(`pnpm install && pnpm build && pnpm link --global`)를 빌드/설치합니다.
2. `openclaw`가 비대화형 쉘의 PATH에 있는지 확인하십시오(필요한 경우 `/usr/local/bin` 또는 `/opt/homebrew/bin`에 대한 심볼릭 링크).
3. 키 인증으로 SSH를 엽니다. LAN 외부에서도 안정적인 연결을 위해서는 **Tailscale** IP를 권장합니다.

## macOS 앱 설정

1. *설정 → 일반*을 엽니다.
2. **OpenClaw 실행**에서 **SSH를 통한 원격**을 선택하고 다음을 설정합니다.
   - **전송**: **SSH 터널** 또는 **직접(ws/wss)**.
   - **SSH 대상**: `user@host` (선택 사항 `:port`).
     - 게이트웨이가 동일한 LAN에 있고 Bonjour를 광고하는 경우 검색된 목록에서 이를 선택하여 이 필드를 자동으로 채웁니다.
   - **게이트웨이 URL**(직접만 해당): `wss://gateway.example.ts.net`(또는 로컬/LAN의 경우 `ws://...`).
   - **ID 파일**(고급): 키의 경로입니다.
   - **프로젝트 루트**(고급): 명령에 사용되는 원격 체크아웃 경로입니다.
   - **CLI 경로**(고급): 실행 가능한 `openclaw` 진입점/바이너리에 대한 선택적 경로(광고 시 자동 채워짐).
3. **원격 테스트**를 누르세요. 성공은 원격 `openclaw status --json`이 올바르게 실행됨을 나타냅니다. 실패는 일반적으로 PATH/CLI 문제를 의미합니다. 종료 127은 CLI를 원격으로 찾을 수 없음을 의미합니다.
4. 이제 상태 확인 및 웹 채팅이 이 SSH 터널을 통해 자동으로 실행됩니다.

## 웹 채팅

- **SSH 터널**: 웹 채팅은 전달된 WebSocket 제어 포트(기본값 18789)를 통해 게이트웨이에 연결됩니다.
- **직접(ws/wss)**: 웹 채팅은 구성된 게이트웨이 URL에 직접 연결됩니다.
- 더 이상 별도의 WebChat HTTP 서버가 없습니다.

## 권한

- 원격 호스트는 로컬과 동일한 TCC 승인(자동화, 접근성, 화면 녹화, 마이크, 음성 인식, 알림)이 필요합니다. 해당 머신에서 온보딩을 실행하여 한 번만 부여하세요.
- 노드는 `node.list` / `node.describe`를 통해 권한 상태를 알리므로 에이전트가 사용 가능한 항목을 알 수 있습니다.

## 보안 참고 사항

- 원격 호스트에서 루프백 바인딩을 선호하고 SSH 또는 Tailscale을 통해 연결합니다.
- 게이트웨이를 루프백이 아닌 인터페이스에 바인딩하는 경우 토큰/비밀번호 인증이 필요합니다.
- [보안](/gateway/security) 및 [Tailscale](/gateway/tailscale)을 참조하세요.

## WhatsApp 로그인 흐름(원격)

- `openclaw channels login --verbose` **원격 호스트**에서 실행합니다. 휴대폰의 WhatsApp으로 QR을 스캔하세요.
- 인증이 만료되면 해당 호스트에서 로그인을 다시 실행합니다. 상태 점검을 통해 링크 문제가 드러납니다.

## 문제 해결

- **exit 127 / notfound**: `openclaw`는 비로그인 쉘의 PATH에 없습니다. `/etc/paths`, 쉘 rc에 추가하거나 `/usr/local/bin`/`/opt/homebrew/bin`에 심볼릭 링크를 추가하세요.
- **상태 프로브 실패**: SSH 연결 가능성, PATH 및 Baileys가 로그인되어 있는지 확인하세요(`openclaw status --json`).
- **웹 채팅 중단**: 게이트웨이가 원격 호스트에서 실행 중이고 전달된 포트가 게이트웨이 WS 포트와 일치하는지 확인합니다. UI에는 정상적인 WS 연결이 필요합니다.
- **노드 IP가 127.0.0.1로 표시됨**: SSH 터널에서 예상됩니다. 게이트웨이가 실제 클라이언트 IP를 볼 수 있도록 하려면 **전송**을 **직접(ws/wss)**로 전환하세요.
- **음성 깨우기**: 원격 모드에서 트리거 문구가 자동으로 전달됩니다. 별도의 전달자가 필요하지 않습니다.

## 알림 소리

`openclaw` 및 `node.invoke`를 사용하여 스크립트에서 알림당 소리를 선택합니다. 예:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

더 이상 앱에 전역 "기본 사운드" 토글이 없습니다. 발신자는 요청에 따라 소리를 선택하거나 없음을 선택합니다.
