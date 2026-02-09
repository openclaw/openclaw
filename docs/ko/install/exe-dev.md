---
summary: "원격 액세스를 위해 exe.dev (VM + HTTPS 프록시)에서 OpenClaw Gateway 실행"
read_when:
  - Gateway(게이트웨이)를 위한 저렴한 상시 실행 Linux 호스트가 필요할 때
  - 자체 VPS 를 운영하지 않고 원격 Control UI 액세스를 원할 때
title: "exe.dev"
---

# exe.dev

목표: exe.dev VM 에서 OpenClaw Gateway 를 실행하고, 노트북에서 다음을 통해 접근 가능하도록 설정합니다: `https://<vm-name>.exe.xyz`

이 페이지는 exe.dev 의 기본 **exeuntu** 이미지 기준으로 작성되었습니다. 다른 배포판을 선택한 경우, 패키지를 이에 맞게 매핑하십시오.

## 초보자를 위한 빠른 경로

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 필요에 따라 인증 키/토큰을 입력합니다
3. VM 옆의 "Agent" 를 클릭하고 대기합니다...
4. ???
5. 수익

## 필요한 것

- exe.dev 계정
- [exe.dev](https://exe.dev) 가상 머신에 대한 `ssh exe.dev` 액세스 (선택 사항)

## Shelley 를 사용한 자동 설치

exe.dev 의 에이전트인 Shelley 는 제공되는 프롬프트를 사용하여 OpenClaw 를 즉시 설치할 수 있습니다. 사용되는 프롬프트는 다음과 같습니다:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 수동 설치

## 1. VM 생성

사용 중인 장치에서:

```bash
ssh exe.dev new
```

그런 다음 연결합니다:

```bash
ssh <vm-name>.exe.xyz
```

팁: 이 VM 은 **stateful** 로 유지하십시오. OpenClaw 는 상태를 `~/.openclaw/` 및 `~/.openclaw/workspace/` 아래에 저장합니다.

## 2. 사전 요구 사항 설치 (VM 에서)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. OpenClaw 설치

OpenClaw 설치 스크립트를 실행합니다:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. nginx 를 설정하여 OpenClaw 를 포트 8000 으로 프록시

`/etc/nginx/sites-enabled/default` 을 다음 내용으로 편집합니다:

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

## 5. OpenClaw 에 접근하고 권한 부여

`https://<vm-name>.exe.xyz/` 에 접근합니다 (온보딩에서 출력된 Control UI 를 참고하십시오). 인증을 요청하는 경우,
VM 의 `gateway.auth.token` 에서 토큰을 붙여넣으십시오 (`openclaw config get gateway.auth.token` 로 조회하거나,
`openclaw doctor --generate-gateway-token` 로 생성할 수 있습니다). `openclaw devices list` 및
`openclaw devices approve <requestId>` 로 디바이스를 승인합니다. 확실하지 않을 경우, 브라우저에서 Shelley 를 사용하십시오!

## 원격 액세스

원격 액세스는 [exe.dev](https://exe.dev) 의 인증을 통해 처리됩니다. 기본적으로
포트 8000 의 HTTP 트래픽은 이메일 인증과 함께 `https://<vm-name>.exe.xyz` 로 전달됩니다.

## 업데이트

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

가이드: [업데이트](/install/updating)
