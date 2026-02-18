---
summary: "exe.dev 에서 OpenClaw 게이트웨이 실행하기 (VM + HTTPS 프록시) 원격 액세스"
read_when:
  - 게이트웨이를 위한 저렴한 항상 켜져 있는 Linux 호스트가 필요할 때
  - 자체 VPS를 운영하지 않고 원격 Control UI 액세스를 원할 때
title: "exe.dev"
---

# exe.dev

목표: exe.dev VM에서 OpenClaw 게이트웨이를 실행하여 노트북에서 `https://<vm-name>.exe.xyz`를 통해 엑세스 가능

이 페이지는 exe.dev의 기본 **exeuntu** 이미지를 가정합니다. 다른 배포판을 선택한 경우, 해당 패키지를 매핑하세요.

## 초보자 빠른 경로

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 필요한 경우 인증 키/토큰을 입력하세요
3. VM 옆의 "Agent"를 클릭하고 기다립니다...
4. ???
5. 수익

## 필요한 것

- exe.dev 계정
- [exe.dev](https://exe.dev) 가상 머신에 대한 `ssh exe.dev` 액세스 (옵션)

## Shelley를 사용한 자동 설치

[exe.dev](https://exe.dev)의 에이전트인 Shelley는 우리의 프롬프트를 통해 OpenClaw를 즉시 설치할 수 있습니다. 사용하는 프롬프트는 다음과 같습니다:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 수동 설치

## 1) VM 생성

장치에서:

```bash
ssh exe.dev new
```

그 다음 연결:

```bash
ssh <vm-name>.exe.xyz
```

팁: 이 VM을 **stateful**로 유지하세요. OpenClaw는 `~/.openclaw/` 및 `~/.openclaw/workspace/`에 상태를 저장합니다.

## 2) 필수 패키지 설치 (VM에서)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) OpenClaw 설치

OpenClaw 설치 스크립트를 실행합니다:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) nginx를 설정하여 OpenClaw를 포트 8000으로 프록시

`/etc/nginx/sites-enabled/default`를 편집하여 다음으로 변경

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

## 5) OpenClaw를 액세스하고 권한 부여

`https://<vm-name>.exe.xyz/`에 액세스하세요 (온보딩에서 출력된 Control UI를 참조하세요). 인증을 요구하면, `gateway.auth.token`에서 생성된 토큰을 붙여 넣으세요 (`openclaw config get gateway.auth.token`으로 검색하거나 `openclaw doctor --generate-gateway-token`으로 생성). `openclaw devices list`와 `openclaw devices approve <requestId>` 명령어를 사용하여 디바이스를 승인하세요. 문제가 있다면, 브라우저에서 Shelley를 사용하세요!

## 원격 액세스

원격 액세스는 [exe.dev](https://exe.dev)의 인증에 의해 처리됩니다. 기본적으로 포트 8000에서 오는 HTTP 트래픽은 이메일 인증을 통해 `https://<vm-name>.exe.xyz`로 전달됩니다.

## 업데이트

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

가이드: [업데이트](/install/updating)
