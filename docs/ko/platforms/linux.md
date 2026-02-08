---
read_when:
    - Linux 컴패니언 앱 상태를 찾고 있습니다.
    - 플랫폼 적용 범위 또는 기여 계획
summary: Linux 지원 + 동반 앱 상태
title: 리눅스 앱
x-i18n:
    generated_at: "2026-02-08T15:59:00Z"
    model: gtx
    provider: google-translate
    source_hash: 93b8250cd1267004a3342c8119462d0442af96704f9b3be250d8ee1eeeb7d4cd
    source_path: platforms/linux.md
    workflow: 15
---

# 리눅스 앱

게이트웨이는 Linux에서 완벽하게 지원됩니다. **노드는 권장 런타임입니다.**.
Bun은 게이트웨이(WhatsApp/Telegram 버그)에는 권장되지 않습니다.

기본 Linux 컴패니언 앱이 계획되어 있습니다. 하나를 만드는 데 도움을 주고 싶다면 기여를 환영합니다.

## 초보자 빠른 경로(VPS)

1. 노드 22+ 설치
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. 노트북에서: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. 열려 있는 `http://127.0.0.1:18789/` 토큰을 붙여넣으세요.

단계별 VPS 가이드: [exe.dev](/install/exe-dev)

## 설치하다

- [시작하기](/start/getting-started)
- [설치 및 업데이트](/install/updating)
- 선택적 흐름: [롤빵 (실험적)](/install/bun), [아니야](/install/nix), [도커](/install/docker)

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

선택하다 **게이트웨이 서비스** 메시지가 표시되면.

복구/마이그레이션:

```
openclaw doctor
```

## 시스템 제어(시스템화된 사용자 단위)

OpenClaw는 systemd를 설치합니다. **사용자** 기본적으로 서비스. 사용 **체계**
공유 또는 상시 접속 서버를 위한 서비스입니다. 전체 유닛 예시 및 지침
에 살다 [게이트웨이 런북](/gateway).

최소 설정:

만들다 `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

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
