---
title: "exe.dev"
summary: "원격 접근을 위한 exe.dev (VM + HTTPS 프록시) 에서 OpenClaw Gateway 실행"
read_when:
  - Gateway 를 위한 저렴한 상시 가동 Linux 호스트를 원할 때
  - 자체 VPS 를 운영하지 않고 원격 Control UI 접근을 원할 때
x-i18n:
  source_path: docs/install/exe-dev.md
---

# exe.dev

목표: exe.dev VM 에서 OpenClaw Gateway 를 실행하여 노트북에서 접근 가능: `https://<vm-name>.exe.xyz`

이 페이지는 exe.dev 의 기본 **exeuntu** 이미지를 가정합니다. 다른 배포판을 선택한 경우 패키지를 적절히 매핑하세요.

## 초보자 빠른 경로

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. 필요에 따라 인증 키/토큰을 입력
3. VM 옆의 "Agent" 를 클릭하고 Shelley 가 프로비저닝을 완료할 때까지 대기
4. `https://<vm-name>.exe.xyz/` 를 열고 Gateway 토큰을 붙여넣어 인증
5. `openclaw devices approve <requestId>` 로 대기 중인 장치 페어링 요청을 승인

## 필요한 것

- exe.dev 계정
- [exe.dev](https://exe.dev) 가상 머신에 대한 `ssh exe.dev` 접근 (선택 사항)

## Shelley 를 사용한 자동 설치

[exe.dev](https://exe.dev) 의 에이전트인 Shelley 가 프롬프트를 사용하여 즉시 OpenClaw 를 설치할 수 있습니다.
사용되는 프롬프트는 다음과 같습니다:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw devices approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## 수동 설치

## 1) VM 생성

장치에서:

```bash
ssh exe.dev new
```

그런 다음 연결:

```bash
ssh <vm-name>.exe.xyz
```

팁: 이 VM 을 **상태 유지**로 유지하세요. OpenClaw 는 `~/.openclaw/` 와 `~/.openclaw/workspace/` 에 상태를 저장합니다.

## 2) 사전 요구사항 설치 (VM 에서)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) OpenClaw 설치

OpenClaw 설치 스크립트를 실행합니다:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) OpenClaw 를 포트 8000 으로 프록시하도록 nginx 설정

`/etc/nginx/sites-enabled/default` 를 다음과 같이 편집합니다:

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

        # WebSocket 지원
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 표준 프록시 헤더
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 장기 연결을 위한 타임아웃 설정
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5) OpenClaw 접근 및 권한 부여

`https://<vm-name>.exe.xyz/` 에 접근합니다 (온보딩의 Control UI 출력 참고). 인증을 요구하면
VM 의 `gateway.auth.token` 에서 토큰을 붙여넣습니다 (`openclaw config get gateway.auth.token` 으로 가져오거나
`openclaw doctor --generate-gateway-token` 으로 생성). `openclaw devices list` 와
`openclaw devices approve <requestId>` 로 장치를 승인합니다. 의문이 있으면 브라우저에서 Shelley 를 사용하세요!

## 원격 접근

원격 접근은 [exe.dev](https://exe.dev) 의 인증에 의해 처리됩니다. 기본적으로
포트 8000 의 HTTP 트래픽은 이메일 인증과 함께 `https://<vm-name>.exe.xyz` 로
전달됩니다.

## 업데이트

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

가이드: [업데이트](/install/updating)
