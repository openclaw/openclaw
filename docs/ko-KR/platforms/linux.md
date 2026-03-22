---
summary: "Linux 지원 + 동반 앱 상태"
read_when:
  - Linux 동반 앱 상태를 확인할 때
  - 플랫폼 지원 범위 또는 기여를 계획할 때
title: "Linux 앱"
x-i18n:
  source_path: docs/platforms/linux.md
---

# Linux 앱

Gateway 는 Linux 에서 완전히 지원됩니다. **Node 가 권장 런타임입니다**.
Bun 은 Gateway 에 권장되지 않습니다 (WhatsApp/Telegram 버그).

네이티브 Linux 동반 앱은 계획 중입니다. 구축에 참여하고 싶으시다면 기여를 환영합니다.

## 초보자 빠른 경로 (VPS)

1. Node 24 설치 (권장; Node 22 LTS, 현재 `22.16+`, 호환성을 위해 여전히 작동)
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. 노트북에서: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/` 를 열고 토큰을 붙여넣기

전체 Linux 서버 가이드: [Linux 서버](/vps). 단계별 VPS 예시: [exe.dev](/install/exe-dev)

## 설치

- [시작하기](/start/getting-started)
- [설치 및 업데이트](/install/updating)
- 선택적 설치: [Bun (실험적)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway 운영 가이드](/gateway)
- [설정](/gateway/configuration)

## Gateway 서비스 설치 (CLI)

다음 중 하나를 사용하세요:

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

프롬프트가 나타나면 **Gateway service** 를 선택하세요.

복구/마이그레이션:

```
openclaw doctor
```

## 시스템 제어 (systemd 사용자 유닛)

OpenClaw 은 기본적으로 systemd **사용자** 서비스를 설치합니다. 공유 또는 상시 가동
서버에는 **시스템** 서비스를 사용하세요. 전체 유닛 예시와 안내는
[Gateway 운영 가이드](/gateway) 에 있습니다.

최소 설정:

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` 를 생성합니다:

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
