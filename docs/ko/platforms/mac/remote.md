---
summary: "SSH 를 통해 원격 OpenClaw Gateway(게이트웨이)를 제어하기 위한 macOS 앱 플로우"
read_when:
  - 원격 mac 제어를 설정하거나 디버깅할 때
title: "원격 제어"
---

# 원격 OpenClaw (macOS ⇄ 원격 호스트)

이 플로우를 사용하면 macOS 앱이 다른 호스트(데스크톱/서버)에서 실행 중인 OpenClaw Gateway(게이트웨이)에 대한 완전한 원격 제어기로 동작합니다. 이는 앱의 **Remote over SSH**(원격 실행) 기능입니다. 상태 확인, Voice Wake 전달, Web Chat 등 모든 기능은 _Settings → General_ 에서 동일한 원격 SSH 구성을 재사용합니다.

## 모드

- **Local (this Mac)**: 모든 것이 노트북에서 실행됩니다. SSH 는 사용되지 않습니다.
- **Remote over SSH (default)**: OpenClaw 명령이 원격 호스트에서 실행됩니다. mac 앱은 `-o BatchMode` 와 선택한 아이덴티티/키, 그리고 로컬 포트 포워딩을 사용하여 SSH 연결을 엽니다.
- **Remote direct (ws/wss)**: SSH 터널을 사용하지 않습니다. mac 앱이 Gateway(게이트웨이) URL 에 직접 연결합니다(예: Tailscale Serve 또는 공용 HTTPS 리버스 프록시를 통해).

## 원격 전송 방식

원격 모드는 두 가지 전송 방식을 지원합니다.

- **SSH tunnel** (default): `ssh -N -L ...` 를 사용하여 Gateway(게이트웨이) 포트를 localhost 로 포워딩합니다. 터널이 loopback 이므로 Gateway(게이트웨이)는 노드의 IP 를 `127.0.0.1` 으로 인식합니다.
- **Direct (ws/wss)**: Gateway(게이트웨이) URL 에 직접 연결합니다. Gateway(게이트웨이)는 실제 클라이언트 IP 를 인식합니다.

## 원격 호스트의 사전 요구 사항

1. Node + pnpm 을 설치하고 OpenClaw CLI 를 빌드/설치합니다(`pnpm install && pnpm build && pnpm link --global`).
2. 비대화형 셸에서 `openclaw` 가 PATH 에 포함되어 있는지 확인합니다(필요한 경우 `/usr/local/bin` 또는 `/opt/homebrew/bin` 로 심볼릭 링크).
3. 키 인증으로 SSH 를 엽니다. LAN 외부에서 안정적인 접근을 위해 **Tailscale** IP 사용을 권장합니다.

## macOS 앱 설정

1. _Settings → General_ 을 엽니다.
2. **OpenClaw runs** 아래에서 **Remote over SSH** 를 선택하고 다음을 설정합니다.
   - **Transport**: **SSH tunnel** 또는 **Direct (ws/wss)**.
   - **SSH target**: `user@host` (선택적으로 `:port`).
     - Gateway(게이트웨이)가 동일한 LAN 에 있고 Bonjour 를 광고하는 경우, 검색된 목록에서 선택하여 이 필드를 자동으로 채울 수 있습니다.
   - **Gateway URL** (Direct 전용): `wss://gateway.example.ts.net` (또는 로컬/LAN 의 경우 `ws://...`).
   - **Identity file** (고급): 키 파일 경로.
   - **Project root** (고급): 명령 실행에 사용되는 원격 체크아웃 경로.
   - **CLI path** (고급): 실행 가능한 `openclaw` 엔트리포인트/바이너리의 선택적 경로(광고되는 경우 자동 채움).
3. **Test remote** 를 클릭합니다. 성공하면 원격 `openclaw status --json` 가 올바르게 실행되고 있음을 의미합니다. 실패는 보통 PATH/CLI 문제를 뜻하며, exit 127 은 원격에서 CLI 를 찾을 수 없음을 의미합니다.
4. 이제 상태 확인과 Web Chat 이 이 SSH 터널을 통해 자동으로 실행됩니다.

## Web Chat

- **SSH tunnel**: Web Chat 은 포워딩된 WebSocket 제어 포트(기본값 18789)를 통해 Gateway(게이트웨이)에 연결합니다.
- **Direct (ws/wss)**: Web Chat 은 설정된 Gateway(게이트웨이) URL 에 직접 연결합니다.
- 더 이상 별도의 WebChat HTTP 서버는 존재하지 않습니다.

## 권한

- 원격 호스트에는 로컬과 동일한 TCC 승인(자동화, 손쉬운 사용, 화면 기록, 마이크, 음성 인식, 알림)이 필요합니다. 해당 머신에서 온보딩을 실행하여 한 번만 부여하면 됩니다.
- 노드는 `node.list` / `node.describe` 를 통해 권한 상태를 광고하므로 에이전트가 사용 가능한 기능을 알 수 있습니다.

## 보안 참고 사항

- 원격 호스트에서는 loopback 바인딩을 선호하고 SSH 또는 Tailscale 을 통해 연결하십시오.
- Gateway(게이트웨이)를 non-loopback 인터페이스에 바인딩하는 경우, 토큰/비밀번호 인증을 요구하십시오.
- [Security](/gateway/security) 및 [Tailscale](/gateway/tailscale) 를 참고하십시오.

## WhatsApp 로그인 플로우 (원격)

- `openclaw channels login --verbose` 을 **원격 호스트에서** 실행합니다. 휴대폰의 WhatsApp 으로 QR 을 스캔합니다.
- 인증이 만료되면 해당 호스트에서 다시 로그인을 실행하십시오. 상태 확인에서 링크 문제가 표시됩니다.

## 문제 해결

- **exit 127 / not found**: `openclaw` 가 비로그인 셸의 PATH 에 없습니다. `/etc/paths`, 셸 rc 에 추가하거나 `/usr/local/bin`/`/opt/homebrew/bin` 로 심볼릭 링크하십시오.
- **Health probe failed**: SSH 접근 가능 여부, PATH, 그리고 Baileys 로그인 상태(`openclaw status --json`)를 확인하십시오.
- **Web Chat stuck**: 원격 호스트에서 Gateway(게이트웨이)가 실행 중인지, 포워딩된 포트가 Gateway(게이트웨이) WS 포트와 일치하는지 확인하십시오. UI 는 정상적인 WS 연결을 필요로 합니다.
- **Node IP shows 127.0.0.1**: SSH 터널 사용 시 정상입니다. Gateway(게이트웨이)가 실제 클라이언트 IP 를 보도록 하려면 **Transport** 를 **Direct (ws/wss)** 로 전환하십시오.
- **Voice Wake**: 트리거 문구는 원격 모드에서 자동으로 전달되며, 별도의 포워더는 필요하지 않습니다.

## 알림 사운드

`openclaw` 및 `node.invoke` 를 사용하여 스크립트에서 알림별로 사운드를 선택하십시오. 예:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

앱에는 더 이상 전역 '기본 사운드' 토글이 없습니다. 호출자는 요청별로 사운드(또는 무음)를 선택합니다.
