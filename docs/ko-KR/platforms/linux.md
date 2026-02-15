---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Planning platform coverage or contributions
title: "Linux App"
x-i18n:
  source_hash: 93b8250cd1267004a3342c8119462d0442af96704f9b3be250d8ee1eeeb7d4cd
---

# 리눅스 앱

게이트웨이는 Linux에서 완벽하게 지원됩니다. **노드는 권장 런타임입니다**.
Bun은 게이트웨이(WhatsApp/Telegram 버그)에는 권장되지 않습니다.

기본 Linux 컴패니언 앱이 계획되어 있습니다. 하나를 만드는 데 도움을 주고 싶다면 기여를 환영합니다.

## 초보자 빠른 경로(VPS)

1. 노드 22+ 설치
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. 노트북에서: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/`를 열고 토큰을 붙여넣습니다.

단계별 VPS 가이드: [exe.dev](/install/exe-dev)

## 설치

- [시작하기](/start/getting-started)
- [설치 및 업데이트](/install/updating)
- 선택적 흐름: [Bun(실험적)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## 게이트웨이

- [게이트웨이 런북](/gateway)
- [구성](/gateway/configuration)

## 게이트웨이 서비스 설치(CLI)

다음 중 하나를 사용하십시오.

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

메시지가 나타나면 **게이트웨이 서비스**를 선택합니다.

복구/마이그레이션:

```
openclaw doctor
```

## 시스템 제어(시스템 사용자 단위)

OpenClaw는 기본적으로 systemd **user** 서비스를 설치합니다. **시스템** 사용
공유 또는 상시 접속 서버를 위한 서비스입니다. 전체 유닛 예시 및 지침
[Gateway Runbook](/gateway)에 살고 있습니다.

최소 설정:

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` 생성:

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
