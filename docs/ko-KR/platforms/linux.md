---
summary: "Linux 지원 + 동반 앱 상태"
read_when:
  - Linux 동반 앱 상태를 찾는 중
  - 플랫폼 커버리지 또는 기여를 계획 중
title: "Linux App"
---

# Linux App

게이트웨이는 Linux에서 완전히 지원됩니다. **Node는 권장 런타임입니다**.
Bun은 게이트웨이(WhatsApp/Telegram 버그)에는 권장되지 않습니다.

Native Linux 동반 앱이 계획되어 있습니다. 개발에 도움을 주시고 싶은 분들의 기여를 환영합니다.

## 초급 빠른 경로 (VPS)

1. Node 22+ 설치
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. 노트북에서: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/`를 열고 토큰을 붙여넣기

단계별 VPS 가이드: [exe.dev](/ko-KR/install/exe-dev)

## 설치

- [시작하기](/ko-KR/start/getting-started)
- [설치 및 업데이트](/ko-KR/install/updating)
- 선택적 흐름: [Bun (실험적)](/ko-KR/install/bun), [Nix](/ko-KR/install/nix), [Docker](/ko-KR/install/docker)

## 게이트웨이

- [게이트웨이 실행 가이드](/ko-KR/gateway)
- [설정](/ko-KR/gateway/configuration)

## 게이트웨이 서비스 설치 (CLI)

다음 중 하나를 사용하십시오:

```
openclaw onboard --install-daemon
```

또는:

```
openclaw gateway install
```

또는:

```
openclaw configure
```

프롬프트가 나타나면 **게이트웨이 서비스**를 선택하십시오.

수리/이전:

```
openclaw doctor
```

## 시스템 제어 (systemd 사용자 유닛)

OpenClaw는 기본적으로 systemd **사용자** 서비스를 설치합니다. 공유 또는 상시 가동 서버에는 **시스템** 서비스를 사용하십시오. 전체 유닛 예제와 지침은 [게이트웨이 실행 가이드](/ko-KR/gateway)에 있습니다.

Minimal setup:

`~/.config/systemd/user/openclaw-gateway[-<profile>].service`를 생성하십시오:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

활성화:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```