---
read_when:
    - 게이트웨이용으로 저렴한 상시 Linux 호스트를 원합니다.
    - 자체 VPS를 실행하지 않고 원격 제어 UI 액세스를 원합니다.
summary: 원격 액세스를 위해 exe.dev(VM + HTTPS 프록시)에서 OpenClaw Gateway 실행
title: exe.dev
x-i18n:
    generated_at: "2026-02-08T15:59:30Z"
    model: gtx
    provider: google-translate
    source_hash: 72ab798afd058a76b597817412ecb622a7d7824dd23c35e8ce9f9d6e6619da25
    source_path: install/exe-dev.md
    workflow: 15
---

# exe.dev

목표: 다음을 통해 노트북에서 연결할 수 있는 exe.dev VM에서 실행되는 OpenClaw Gateway `https://<vm-name>.exe.xyz`

이 페이지에서는 exe.dev의 기본값을 가정합니다. **엑슨투** 영상. 다른 배포판을 선택한 경우 이에 따라 패키지를 매핑하세요.

## 초보자 빠른 경로

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 필요에 따라 인증 키/토큰을 입력하세요.
3. VM 옆에 있는 "에이전트"를 클릭하고 기다립니다.
4. ???
5. 이익

## 필요한 것

- exe.dev 계정
- `ssh exe.dev` 접근하다 [exe.dev](https://exe.dev) 가상 머신(선택 사항)

## Shelley를 사용한 자동 설치

셸리, [exe.dev](https://exe.dev)의 에이전트는 당사를 통해 즉시 OpenClaw를 설치할 수 있습니다.
프롬프트. 사용된 프롬프트는 다음과 같습니다.

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 수동 설치

## 1) VM 생성

기기에서:

```bash
ssh exe.dev new
```

그런 다음 연결하십시오.

```bash
ssh <vm-name>.exe.xyz
```

팁: 이 VM을 유지하세요 **상태 저장**. OpenClaw는 상태를 다음과 같이 저장합니다. `~/.openclaw/` 그리고 `~/.openclaw/workspace/`.

## 2) 필수 구성 요소 설치(VM에)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) 오픈클로 설치

OpenClaw 설치 스크립트를 실행합니다:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) OpenClaw를 포트 8000으로 프록시하도록 nginx를 설정합니다.

편집하다 `/etc/nginx/sites-enabled/default` ~와 함께

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5) OpenClaw 접속 및 권한 부여

입장 `https://<vm-name>.exe.xyz/` (온보딩의 Control UI 출력 참조) 인증을 묻는 메시지가 나타나면
토큰 `gateway.auth.token` VM에서(다음으로 검색 `openclaw config get gateway.auth.token`또는 생성
와 `openclaw doctor --generate-gateway-token`). 다음이 포함된 기기를 승인하세요. `openclaw devices list` 그리고 
`openclaw devices approve <requestId>`. 의심스러우면 브라우저에서 Shelley를 사용해 보세요!

## 원격 액세스

원격 액세스는 다음에 의해 처리됩니다. [exe.dev](https://exe.dev)님의 인증입니다. 작성자:
기본적으로 포트 8000의 HTTP 트래픽은 다음으로 전달됩니다. `https://<vm-name>.exe.xyz`
이메일 인증으로.

## 업데이트 중

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

가이드: [업데이트 중](/install/updating)
