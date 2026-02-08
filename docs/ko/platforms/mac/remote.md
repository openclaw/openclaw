---
read_when:
    - 원격 Mac 제어 설정 또는 디버깅
summary: SSH를 통해 원격 OpenClaw 게이트웨이를 제어하기 위한 macOS 앱 흐름
title: 원격 제어
x-i18n:
    generated_at: "2026-02-08T16:04:57Z"
    model: gtx
    provider: google-translate
    source_hash: 61b43707250d5515fd0f85f092bdde24598f14904398ff3fca3736bcc48d72f8
    source_path: platforms/mac/remote.md
    workflow: 15
---

# 원격 OpenClaw(macOS ⇄ 원격 호스트)

이 흐름을 통해 macOS 앱은 다른 호스트(데스크톱/서버)에서 실행되는 OpenClaw 게이트웨이에 대한 완전한 원격 제어 역할을 할 수 있습니다. 앱의 내용입니다 **SSH를 통한 원격** (원격 실행) 기능입니다. 상태 확인, 음성 깨우기 전달, 웹 채팅 등 모든 기능은 동일한 원격 SSH 구성을 재사용합니다. _설정 → 일반_.

## 모드

- **로컬(이 Mac)**: 모든 것이 노트북에서 실행됩니다. SSH가 포함되지 않았습니다.
- **SSH를 통한 원격(기본값)**: OpenClaw 명령은 원격 호스트에서 실행됩니다. Mac 앱은 SSH 연결을 엽니다. `-o BatchMode` 선택한 ID/키와 로컬 포트 ​​전달도 포함됩니다.
- **원격 직접(ws/wss)**: SSH 터널이 없습니다. Mac 앱은 게이트웨이 URL에 직접 연결됩니다(예: Tailscale Serve 또는 공용 HTTPS 역방향 프록시를 통해).

## 원격 운송

원격 모드는 두 가지 전송을 지원합니다.

- **SSH 터널** (기본값): 용도 `ssh -N -L ...` 게이트웨이 포트를 localhost로 전달합니다. 게이트웨이는 노드의 IP를 다음과 같이 표시합니다. `127.0.0.1` 터널이 루프백이기 때문입니다.
- **직접(ws/wss)**: 게이트웨이 URL로 바로 연결됩니다. 게이트웨이는 실제 클라이언트 IP를 봅니다.

## 원격 호스트의 전제조건

1. Node + pnpm을 설치하고 OpenClaw CLI를 빌드/설치합니다(`pnpm install && pnpm build && pnpm link --global`).
2. 보장하다 `openclaw` 비대화형 쉘의 PATH에 있습니다(symlink `/usr/local/bin` 또는 `/opt/homebrew/bin` 필요한 경우).
3. 키 인증으로 SSH를 엽니다. 우리는 추천합니다 **테일스케일** LAN 외부에서도 안정적인 연결을 위한 IP입니다.

## macOS 앱 설정

1. 열려 있는 _설정 → 일반_.
2. 아래에 **OpenClaw 실행**, 선택하다 **SSH를 통한 원격** 다음을 설정합니다.
   - **수송**: **SSH 터널** 또는 **직접(ws/wss)**.
   - **SSH 대상**: `user@host` (선택 과목 `:port`).
     - 게이트웨이가 동일한 LAN에 있고 Bonjour를 광고하는 경우 검색된 목록에서 이를 선택하여 이 필드를 자동으로 채웁니다.
   - **게이트웨이 URL** (직접만 해당): `wss://gateway.example.ts.net` (또는 `ws://...` 로컬/LAN의 경우).
   - **신원 파일** (고급): 키의 경로입니다.
   - **프로젝트 루트** (고급): 명령에 사용되는 원격 체크아웃 경로입니다.
   - **CLI 경로** (고급): 실행 가능 파일에 대한 선택적 경로 `openclaw` 진입점/바이너리(광고 시 자동 입력).
3. 때리다 **원격 테스트**. 성공은 원격을 나타냅니다 `openclaw status --json` 올바르게 실행됩니다. 실패는 일반적으로 PATH/CLI 문제를 의미합니다. 종료 127은 CLI를 원격으로 찾을 수 없음을 의미합니다.
4. 이제 상태 확인 및 웹 채팅이 이 SSH 터널을 통해 자동으로 실행됩니다.

## 웹 채팅

- **SSH 터널**: 웹 채팅은 전달된 WebSocket 제어 포트(기본값 18789)를 통해 게이트웨이에 연결됩니다.
- **직접(ws/wss)**: 웹 채팅은 구성된 게이트웨이 URL에 바로 연결됩니다.
- 더 이상 별도의 WebChat HTTP 서버가 없습니다.

## 권한

- 원격 호스트에는 로컬과 동일한 TCC 승인(자동화, 접근성, 화면 녹화, 마이크, 음성 인식, 알림)이 필요합니다. 해당 머신에서 온보딩을 실행하여 한 번만 부여하세요.
- 노드는 다음을 통해 권한 상태를 알립니다. `node.list` / `node.describe` 상담원이 어떤 서비스를 이용할 수 있는지 알 수 있습니다.

## 보안 참고 사항

- 원격 호스트에서 루프백 바인딩을 선호하고 SSH 또는 Tailscale을 통해 연결합니다.
- 게이트웨이를 비루프백 인터페이스에 바인딩하는 경우 토큰/비밀번호 인증이 필요합니다.
- 보다 [보안](/gateway/security) 그리고 [테일스케일](/gateway/tailscale).

## WhatsApp 로그인 흐름(원격)

- 달리다 `openclaw channels login --verbose` **원격 호스트에서**. 휴대폰의 WhatsApp으로 QR을 스캔하세요.
- 인증이 만료되면 해당 호스트에서 로그인을 다시 실행하십시오. 상태 점검을 통해 링크 문제가 드러납니다.

## 문제 해결

- **127번 출구 / 찾을 수 없음**: `openclaw` 비로그인 쉘의 경우 PATH에 없습니다. 다음에 추가하세요 `/etc/paths`, 쉘 rc 또는 심볼릭 링크 `/usr/local/bin` / `/opt/homebrew/bin`.
- **상태 프로브 실패**: SSH 연결 가능성, PATH 및 Baileys가 로그인되어 있는지 확인합니다(`openclaw status --json`).
- **웹 채팅이 멈췄습니다.**: 게이트웨이가 원격 호스트에서 실행 중이고 전달된 포트가 게이트웨이 WS 포트와 일치하는지 확인합니다. UI에는 정상적인 WS 연결이 필요합니다.
- **노드 IP는 127.0.0.1을 표시합니다.**: SSH 터널에서 예상됩니다. 스위치 **수송** 에게 **직접(ws/wss)** 게이트웨이가 실제 클라이언트 IP를 확인하도록 하려는 경우.
- **음성 웨이크**: 트리거 문구는 원격 모드에서 자동으로 전달됩니다. 별도의 전달자가 필요하지 않습니다.

## 알림 소리

다음을 사용하여 스크립트에서 알림당 소리를 선택하세요. `openclaw` 그리고 `node.invoke`, 예:

```bash
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass
```

더 이상 앱에 전역 "기본 사운드" 토글이 없습니다. 발신자는 요청에 따라 소리를 선택하거나 없음을 선택합니다.
