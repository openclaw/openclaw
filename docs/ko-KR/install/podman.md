---
title: "Podman"
summary: "루트리스 Podman 컨테이너에서 OpenClaw 실행"
read_when:
  - Docker 대신 Podman 으로 컨테이너화된 Gateway 를 원할 때
x-i18n:
  source_path: docs/install/podman.md
---

# Podman

**루트리스** Podman 컨테이너에서 OpenClaw Gateway 를 실행합니다. Docker 와 동일한 이미지 (저장소 [Dockerfile](https://github.com/openclaw/openclaw/blob/main/Dockerfile) 에서 빌드) 를 사용합니다.

## 사전 요구사항

- **Podman** (루트리스 모드)
- 일회성 설정 (전용 사용자 생성 및 이미지 빌드) 을 위한 **sudo** 접근

## 빠른 시작

<Steps>
  <Step title="일회성 설정">
    저장소 루트에서 설정 스크립트를 실행합니다. 전용 `openclaw` 사용자를 생성하고, 컨테이너 이미지를 빌드하며, 실행 스크립트를 설치합니다:

    ```bash
    ./scripts/podman/setup.sh
    ```

    이 스크립트는 Gateway 가 마법사를 실행하지 않고도 시작할 수 있도록 `~openclaw/.openclaw/openclaw.json` 에 최소 설정 (`gateway.mode` 를 `"local"` 로 설정) 도 생성합니다.

    기본적으로 컨테이너는 systemd 서비스로 설치되지 **않습니다** -- 다음 단계에서 수동으로 시작합니다. 자동 시작 및 재시작이 포함된 프로덕션 스타일 설정을 위해서는 대신 `--quadlet` 을 전달하세요:

    ```bash
    ./scripts/podman/setup.sh --quadlet
    ```

    (또는 `OPENCLAW_PODMAN_QUADLET=1` 을 설정하세요. 컨테이너와 실행 스크립트만 설치하려면 `--container` 를 사용하세요.)

    **선택적 빌드 시 환경 변수** (`scripts/podman/setup.sh` 실행 전에 설정):

    - `OPENCLAW_DOCKER_APT_PACKAGES` -- 이미지 빌드 시 추가 apt 패키지 설치.
    - `OPENCLAW_EXTENSIONS` -- 플러그인 의존성 사전 설치 (공백 구분 이름, 예: `diagnostics-otel matrix`).

  </Step>

  <Step title="Gateway 시작">
    빠른 수동 실행을 위해:

    ```bash
    ./scripts/run-openclaw-podman.sh launch
    ```

  </Step>

  <Step title="온보딩 마법사 실행">
    채널이나 프로바이더를 대화형으로 추가하려면:

    ```bash
    ./scripts/run-openclaw-podman.sh launch setup
    ```

    그런 다음 `http://127.0.0.1:18789/` 를 열고 `~openclaw/.openclaw/.env` 에 있는 토큰 (또는 설정에서 출력된 값) 을 사용하세요.

  </Step>
</Steps>

## Systemd (Quadlet, 선택 사항)

`./scripts/podman/setup.sh --quadlet` (또는 `OPENCLAW_PODMAN_QUADLET=1`) 을 실행한 경우, [Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html) 유닛이 설치되어 Gateway 가 openclaw 사용자의 systemd 사용자 서비스로 실행됩니다. 서비스는 설정 종료 시 활성화되고 시작됩니다.

- **시작:** `sudo systemctl --machine openclaw@ --user start openclaw.service`
- **중지:** `sudo systemctl --machine openclaw@ --user stop openclaw.service`
- **상태:** `sudo systemctl --machine openclaw@ --user status openclaw.service`
- **로그:** `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`

quadlet 파일은 `~openclaw/.config/containers/systemd/openclaw.container` 에 있습니다. 포트나 env 를 변경하려면 해당 파일 (또는 소스하는 `.env`) 을 편집한 다음 `sudo systemctl --machine openclaw@ --user daemon-reload` 후 서비스를 재시작하세요. 부팅 시 openclaw 에 대해 lingering 이 활성화되어 있으면 (설정 시 loginctl 이 사용 가능한 경우 수행됨) 서비스가 자동으로 시작됩니다.

초기 설정에서 사용하지 않은 경우 나중에 quadlet 을 추가하려면 다시 실행하세요: `./scripts/podman/setup.sh --quadlet`.

## openclaw 사용자 (비로그인)

`scripts/podman/setup.sh` 는 전용 시스템 사용자 `openclaw` 을 생성합니다:

- **셸:** `nologin` — 대화형 로그인 불가; 공격 면적 감소.
- **홈:** 예: `/home/openclaw` — `~/.openclaw` (설정, 작업 공간) 과 실행 스크립트 `run-openclaw-podman.sh` 를 보관합니다.
- **루트리스 Podman:** 사용자에게 **subuid** 및 **subgid** 범위가 있어야 합니다. 많은 배포판에서 사용자 생성 시 자동으로 할당합니다. 설정에서 경고가 출력되면 `/etc/subuid` 와 `/etc/subgid` 에 라인을 추가하세요:

  ```text
  openclaw:100000:65536
  ```

  그런 다음 해당 사용자로 Gateway 를 시작합니다 (예: cron 또는 systemd 에서):

  ```bash
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
  sudo -u openclaw /home/openclaw/run-openclaw-podman.sh setup
  ```

- **설정:** `openclaw` 과 root 만 `/home/openclaw/.openclaw` 에 접근할 수 있습니다. 설정을 편집하려면: Gateway 가 실행 중이면 Control UI 를 사용하거나, `sudo -u openclaw $EDITOR /home/openclaw/.openclaw/openclaw.json` 을 사용하세요.

## 환경 및 설정

- **토큰:** `~openclaw/.openclaw/.env` 에 `OPENCLAW_GATEWAY_TOKEN` 으로 저장됩니다. `scripts/podman/setup.sh` 와 `run-openclaw-podman.sh` 가 없으면 생성합니다 (`openssl`, `python3` 또는 `od` 사용).
- **선택 사항:** 해당 `.env` 에서 프로바이더 키 (예: `GROQ_API_KEY`, `OLLAMA_API_KEY`) 와 기타 OpenClaw 환경 변수를 설정할 수 있습니다.
- **호스트 포트:** 기본적으로 스크립트는 `18789` (Gateway) 와 `18790` (브릿지) 을 매핑합니다. 실행 시 `OPENCLAW_PODMAN_GATEWAY_HOST_PORT` 와 `OPENCLAW_PODMAN_BRIDGE_HOST_PORT` 로 **호스트** 포트 매핑을 재정의하세요.
- **Gateway 바인드:** 기본적으로 `run-openclaw-podman.sh` 는 안전한 로컬 접근을 위해 `--bind loopback` 으로 Gateway 를 시작합니다. LAN 에 노출하려면 `OPENCLAW_GATEWAY_BIND=lan` 을 설정하고 `openclaw.json` 에서 `gateway.controlUi.allowedOrigins` 를 구성하세요 (또는 명시적으로 호스트 헤더 폴백을 활성화).
- **경로:** 호스트 설정 및 작업 공간은 기본적으로 `~openclaw/.openclaw` 과 `~openclaw/.openclaw/workspace` 입니다. 실행 스크립트에서 사용하는 호스트 경로를 `OPENCLAW_CONFIG_DIR` 과 `OPENCLAW_WORKSPACE_DIR` 로 재정의하세요.

## 스토리지 모델

- **영속적 호스트 데이터:** `OPENCLAW_CONFIG_DIR` 과 `OPENCLAW_WORKSPACE_DIR` 이 컨테이너에 바인드 마운트되어 호스트에 상태를 유지합니다.
- **임시 샌드박스 tmpfs:** `agents.defaults.sandbox` 를 활성화하면 도구 샌드박스 컨테이너가 `/tmp`, `/var/tmp`, `/run` 에 `tmpfs` 를 마운트합니다. 이 경로들은 메모리 기반이며 샌드박스 컨테이너와 함께 사라집니다. 최상위 Podman 컨테이너 설정은 자체 tmpfs 마운트를 추가하지 않습니다.
- **디스크 증가 핫스팟:** 주시할 주요 경로는 `media/`, `agents/<agentId>/sessions/sessions.json`, 트랜스크립트 JSONL 파일, `cron/runs/*.jsonl`, 그리고 `/tmp/openclaw/` (또는 구성된 `logging.file`) 아래의 롤링 파일 로그입니다.

`scripts/podman/setup.sh` 는 이제 이미지 tar 를 프라이빗 임시 디렉토리에 스테이징하고 설정 중 선택된 기본 디렉토리를 출력합니다. 비루트 실행의 경우 해당 기본이 안전하게 사용할 수 있을 때만 `TMPDIR` 을 허용합니다. 그렇지 않으면 `/var/tmp`, 그다음 `/tmp` 로 대체합니다. 저장된 tar 는 소유자 전용이며 대상 사용자의 `podman load` 로 스트리밍되므로 프라이빗 호출자 임시 디렉토리가 설정을 차단하지 않습니다.

## 유용한 명령어

- **로그:** Quadlet 사용: `sudo journalctl --machine openclaw@ --user -u openclaw.service -f`. 스크립트 사용: `sudo -u openclaw podman logs -f openclaw`
- **중지:** Quadlet 사용: `sudo systemctl --machine openclaw@ --user stop openclaw.service`. 스크립트 사용: `sudo -u openclaw podman stop openclaw`
- **다시 시작:** Quadlet 사용: `sudo systemctl --machine openclaw@ --user start openclaw.service`. 스크립트 사용: 실행 스크립트 재실행 또는 `podman start openclaw`
- **컨테이너 제거:** `sudo -u openclaw podman rm -f openclaw` — 호스트의 설정 및 작업 공간은 유지됩니다

## 문제 해결

- **설정 또는 auth-profiles 에서 권한 거부 (EACCES):** 컨테이너는 기본적으로 `--userns=keep-id` 를 사용하고 스크립트를 실행하는 호스트 사용자와 동일한 uid/gid 로 실행됩니다. 호스트 `OPENCLAW_CONFIG_DIR` 과 `OPENCLAW_WORKSPACE_DIR` 이 해당 사용자 소유인지 확인하세요.
- **Gateway 시작 차단 (`gateway.mode=local` 누락):** `~openclaw/.openclaw/openclaw.json` 이 존재하고 `gateway.mode="local"` 이 설정되어 있는지 확인하세요. `scripts/podman/setup.sh` 가 없으면 이 파일을 생성합니다.
- **openclaw 사용자에 대해 루트리스 Podman 실패:** `/etc/subuid` 와 `/etc/subgid` 에 `openclaw` 에 대한 라인이 있는지 확인하세요 (예: `openclaw:100000:65536`). 없으면 추가하고 재시작하세요.
- **컨테이너 이름 사용 중:** 실행 스크립트는 `podman run --replace` 를 사용하므로 다시 시작할 때 기존 컨테이너가 교체됩니다. 수동으로 정리하려면: `podman rm -f openclaw`.
- **openclaw 으로 실행할 때 스크립트를 찾을 수 없음:** `scripts/podman/setup.sh` 가 실행되어 `run-openclaw-podman.sh` 가 openclaw 의 홈 (예: `/home/openclaw/run-openclaw-podman.sh`) 에 복사되었는지 확인하세요.
- **Quadlet 서비스를 찾을 수 없거나 시작 실패:** `.container` 파일을 편집한 후 `sudo systemctl --machine openclaw@ --user daemon-reload` 를 실행하세요. Quadlet 은 cgroups v2 가 필요합니다: `podman info --format '{{.Host.CgroupsVersion}}'` 이 `2` 를 표시해야 합니다.

## 선택 사항: 자신의 사용자로 실행

자신의 일반 사용자로 Gateway 를 실행하려면 (전용 openclaw 사용자 없이): 이미지를 빌드하고, `OPENCLAW_GATEWAY_TOKEN` 이 있는 `~/.openclaw/.env` 를 생성하고, `--userns=keep-id` 와 `~/.openclaw` 에 대한 마운트로 컨테이너를 실행하세요. 실행 스크립트는 openclaw 사용자 플로우를 위해 설계되었습니다. 단일 사용자 설정의 경우 스크립트에서 `podman run` 명령을 수동으로 실행하여 설정과 작업 공간을 홈으로 지정할 수 있습니다. 대부분의 사용자에게 권장: `scripts/podman/setup.sh` 를 사용하고 openclaw 사용자로 실행하여 설정과 프로세스를 격리하세요.
