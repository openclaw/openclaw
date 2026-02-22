---
summary: "루트리스 Podman 컨테이너에서 OpenClaw 실행하기"
read_when:
  - Docker 대신 Podman 컨테이너화된 게이트웨이를 사용하려는 경우
title: "Podman"
---

# Podman

루트리스 Podman 컨테이너에서 OpenClaw 게이트웨이를 실행하세요. Docker와 동일한 이미지를 사용합니다 (레포지토리 [Dockerfile](https://github.com/openclaw/openclaw/blob/main/Dockerfile)에서 빌드).

## 요구 사항

- Podman (루트리스)
- 1회 설정을 위한 Sudo (사용자 생성, 이미지 빌드)

## 빠른 시작

**1. 1회 설정** (레포지토리 루트에서; 사용자 생성, 이미지 빌드, 실행 스크립트 설치):

```bash
./setup-podman.sh
```

이는 또한 `~openclaw/.openclaw/openclaw.json`에 최소한의 설정을 생성하여 게이트웨이가 마법사를 실행하지 않고 시작할 수 있도록 합니다 (`gateway.mode="local"` 설정). 기본적으로 컨테이너는 systemd 서비스로 설치되지 않으며, 수동으로 시작해야 합니다 (아래 참조). 자동 시작 및 재시작이 포함된 프로덕션 스타일 설정을 위해서는 systemd Quadlet 사용자 서비스로 설치하세요:

```bash
./setup-podman.sh --quadlet
```

(또는 `OPENCLAW_PODMAN_QUADLET=1` 설정; 오직 컨테이너와 실행 스크립트만 설치하려면 `--container` 사용).

**2. 게이트웨이 시작** (수동, 빠른 테스트 용도):

```bash
./scripts/run-openclaw-podman.sh launch
```

**3. 온보딩 마법사** (예: 채널 또는 프로바이더 추가):

```bash
./scripts/run-openclaw-podman.sh launch setup
```

그리고 `http://127.0.0.1:18789/`를 열고 `~openclaw/.openclaw/.env`에 있는 토큰을 사용합니다 (또는 설정 과정에서 출력된 값 사용).

## Systemd (Quadlet, 선택 사항)

`./setup-podman.sh --quadlet` (또는 `OPENCLAW_PODMAN_QUADLET=1`)을 실행했다면, [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) 유닛이 설치되어 openclaw 사용자를 위한 systemd 사용자 서비스로 게이트웨이가 실행됩니다. 설정이 끝날 때 서비스가 활성화되고 시작됩니다.

- **시작:** `sudo systemctl --machine openclaw@ --user start openclaw.service`
- **중지:** `sudo systemctl --machine openclaw@ --user stop openclaw.service`
- **상태:** `sudo systemctl --machine openclaw@ --user status openclaw.service`
- **로그:** `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`

Quadlet 파일은 `~openclaw/.config/containers/systemd/openclaw.container`에 위치합니다. 포트 또는 환경을 변경하려면 해당 파일 (또는 그것이 참조하는 `.env`)을 편집한 후 `sudo systemctl --machine openclaw@ --user daemon-reload`를 실행하고 서비스를 다시 시작하세요. 부팅 시, lingering이 openclaw에 대해 활성화되어 있으면 서비스가 자동으로 시작됩니다 (loginctl이 사용 가능한 경우 설정 시에 수행).

초기 설정 후에 Quadlet을 추가하려면 `./setup-podman.sh --quadlet`를 다시 실행하세요.

## openclaw 사용자 (로그인 불가)

`setup-podman.sh`는 시스템 전용 사용자 `openclaw`를 생성합니다:

- **쉘:** `nologin` — 인터랙티브 로그인 불가; 공격 표면 감소.
- **홈 디렉터리:** 예를 들어 `/home/openclaw` — `~/.openclaw` (설정, 작업공간)을 보유하며 실행 스크립트 `run-openclaw-podman.sh`를 포함.
- **루트리스 Podman:** 사용자는 **subuid**와 **subgid** 범위를 가져야 합니다. 많은 배포판에서 사용자를 생성할 때 이를 자동으로 할당합니다. 설정 과정에서 경고가 표시되면 `/etc/subuid` 및 `/etc/subgid`에 줄을 추가하세요:

  ```text
  openclaw:100000:65536
  ```

  그런 다음 해당 사용자로 게이트웨이를 시작하세요 (예: cron 또는 systemd에서):

  ```bash
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh setup
  ```

- **설정:** 오직 `openclaw` 및 루트만이 `/home/openclaw/.openclaw`에 접근할 수 있습니다. 설정을 편집하려면: 게이트웨이가 실행 중인 동안 컨트롤 UI를 사용하거나 `sudo -u openclaw $EDITOR /home/openclaw/.openclaw/openclaw.json`을 사용하세요.

## 환경 및 설정

- **토큰:** `~openclaw/.openclaw/.env`에 `OPENCLAW_GATEWAY_TOKEN`으로 저장됩니다. `setup-podman.sh` 및 `run-openclaw-podman.sh`는 누락 시 이를 생성합니다 (`openssl`, `python3`, 또는 `od` 사용).
- **옵션:** 해당 `.env`에서 프로바이더 키 (예: `GROQ_API_KEY`, `OLLAMA_API_KEY`) 및 기타 OpenClaw 환경 변수를 설정할 수 있습니다.
- **호스트 포트:** 기본적으로 스크립트는 `18789` (게이트웨이) 및 `18790` (브리지)을 매핑합니다. 실행 시 `OPENCLAW_PODMAN_GATEWAY_HOST_PORT` 및 `OPENCLAW_PODMAN_BRIDGE_HOST_PORT`으로 **호스트** 포트 매핑을 재정의합니다.
- **경로:** 호스트 설정 및 작업공간은 기본적으로 `~openclaw/.openclaw` 및 `~openclaw/.openclaw/workspace`로 설정됩니다. 실행 스크립트에서 사용하는 호스트 경로를 `OPENCLAW_CONFIG_DIR` 및 `OPENCLAW_WORKSPACE_DIR`으로 재정의합니다.

## 유용한 명령어

- **로그:** Quadlet 사용 시: `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`. 스크립트 사용 시: `sudo -u openclaw podman logs -f openclaw`
- **중지:** Quadlet 사용 시: `sudo systemctl --machine openclaw@ --user stop openclaw.service`. 스크립트 사용 시: `sudo -u openclaw podman stop openclaw`
- **다시 시작:** Quadlet 사용 시: `sudo systemctl --machine openclaw@ --user start openclaw.service`. 스크립트 사용 시: 실행 스크립트를 재실행하거나 `podman start openclaw`
- **컨테이너 제거:** `sudo -u openclaw podman rm -f openclaw` — 호스트의 설정 및 작업공간은 유지됩니다

## 문제 해결

- **설정 또는 인증 프로파일에서 권한 거부 (EACCES):** 컨테이너는 기본적으로 `--userns=keep-id`로 설정되어 있으며, 스크립트를 실행하는 호스트 사용자와 같은 uid/gid로 실행됩니다. 호스트 `OPENCLAW_CONFIG_DIR` 및 `OPENCLAW_WORKSPACE_DIR`이 해당 사용자에 의해 소유되고 있는지 확인하세요.
- **게이트웨이 시작 차단 (누락된 `gateway.mode=local`):** `~openclaw/.openclaw/openclaw.json`이 존재하고 `gateway.mode="local"`로 설정되어 있는지 확인하세요. `setup-podman.sh`는 누락 시 이 파일을 생성합니다.
- **루트리스 Podman이 openclaw 사용자에 대해 실패함:** `/etc/subuid` 및 `/etc/subgid`에 `openclaw`에 대한 줄이 포함되어 있는지 확인하십시오 (예: `openclaw:100000:65536`). 누락 시 추가하고 재시작하십시오.
- **컨테이너 이름 사용 중:** 실행 스크립트는 `podman run --replace`를 사용하여 실행할 때 기존 컨테이너를 대체합니다. 수동 정리를 위해: `podman rm -f openclaw`.
- ** openclaw로 실행할 때 스크립트를 찾을 수 없음:** `setup-podman.sh`를 실행하여 `run-openclaw-podman.sh`가 openclaw의 홈에 복사되었는지 확인하십시오 (예: `/home/openclaw/run-openclaw-podman.sh`).
- **Quadlet 서비스 없거나 시작 실패:** `.container` 파일을 편집한 후 `sudo systemctl --machine openclaw@ --user daemon-reload`를 실행하세요. Quadlet은 cgroups v2를 필요로 합니다: `podman info --format '{{.Host.CgroupsVersion}}'`은 `2`를 표시해야 합니다.

## 선택 사항: 자신의 사용자로 실행하기

정상 사용자로 게이트웨이를 실행하려면 (전용 openclaw 사용자 없이): 이미지를 빌드하고 `~/.openclaw/.env`에 `OPENCLAW_GATEWAY_TOKEN`을 생성한 후 자신의 `~/.openclaw`에 마운트 및 `--userns=keep-id`로 컨테이너를 실행하세요. 실행 스크립트는 openclaw 사용자 흐름에 맞춰 설계되었습니다; 단일 사용자 설정을 위해 스크립트의 `podman run` 명령어를 수동으로 실행하고 설정 및 작업공간을 자신의 홈으로 지정할 수 있습니다. 대부분의 사용자에게 권장: `setup-podman.sh`를 사용하고 openclaw 사용자로 실행하여 설정 및 프로세스를 격리하세요.
