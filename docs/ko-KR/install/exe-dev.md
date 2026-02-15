---
summary: "Run OpenClaw Gateway on exe.dev (VM + HTTPS proxy) for remote access"
read_when:
  - You want a cheap always-on Linux host for the Gateway
  - You want remote Control UI access without running your own VPS
title: "exe.dev"
x-i18n:
  source_hash: 72ab798afd058a76b597817412ecb622a7d7824dd23c35e8ce9f9d6e6619da25
---

#exe.dev

목표: 다음을 통해 노트북에서 연결할 수 있는 exe.dev VM에서 실행되는 OpenClaw Gateway: `https://<vm-name>.exe.xyz`

이 페이지에서는 exe.dev의 기본 **exeuntu** 이미지를 가정합니다. 다른 배포판을 선택한 경우 이에 따라 패키지를 매핑하세요.

## 초보자 빠른 경로

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 필요에 따라 인증 키/토큰을 입력하세요.
3. VM 옆에 있는 "에이전트"를 클릭하고 기다립니다.
4. ???
5. 이익

## 필요한 것

- exe.dev 계정
- `ssh exe.dev` [exe.dev](https://exe.dev) 가상 머신에 대한 액세스(선택 사항)

## Shelley를 사용한 자동 설치

[exe.dev](https://exe.dev)의 에이전트인 Shelley는 다음을 통해 OpenClaw를 즉시 설치할 수 있습니다.
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

팁: 이 VM을 **상태 저장**으로 유지하세요. OpenClaw는 `~/.openclaw/` 및 `~/.openclaw/workspace/`에 상태를 저장합니다.

## 2) 필수 구성 요소 설치(VM에)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) OpenClaw 설치

OpenClaw 설치 스크립트를 실행합니다:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) OpenClaw를 포트 8000으로 프록시하도록 nginx 설정

`/etc/nginx/sites-enabled/default`를 다음과 같이 편집하세요.

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

`https://<vm-name>.exe.xyz/`에 액세스합니다(온보딩의 Control UI 출력 참조). 인증을 묻는 메시지가 나타나면
VM에 있는 `gateway.auth.token`의 토큰(`openclaw config get gateway.auth.token`로 검색하거나 생성)
`openclaw doctor --generate-gateway-token`)를 사용합니다. `openclaw devices list`를 사용하여 장치를 승인하고
`openclaw devices approve <requestId>`. 의심스러우면 브라우저에서 Shelley를 사용해 보세요!

## 원격 액세스

원격 접속은 [exe.dev](https://exe.dev)의 인증을 통해 처리됩니다. 작성자:
기본적으로 포트 8000의 HTTP 트래픽은 `https://<vm-name>.exe.xyz`로 전달됩니다.
이메일 인증으로.

## 업데이트 중

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

가이드: [업데이트 중](/install/updating)
