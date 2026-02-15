---
summary: "CLI reference for `openclaw plugins` (list, install, uninstall, enable/disable, doctor)"
read_when:
  - You want to install or manage in-process Gateway plugins
  - You want to debug plugin load failures
title: "plugins"
x-i18n:
  source_hash: 48d90017a0663d9abd34ab9776baaf81bc6a78b276b7b669cbbc27e5d0011498
---

# `openclaw plugins`

게이트웨이 플러그인/확장(프로세스 내 로드됨)을 관리합니다.

관련 항목:

- 플러그인 시스템: [플러그인](/tools/plugin)
- 플러그인 매니페스트 + 스키마: [플러그인 매니페스트](/plugins/manifest)
- 보안 강화 : [보안](/gateway/security)

## 명령

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins uninstall <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

번들 플러그인은 OpenClaw와 함께 제공되지만 시작은 비활성화됩니다. `plugins enable`를 사용하여
활성화하십시오.

모든 플러그인은 인라인 JSON 스키마가 포함된 `openclaw.plugin.json` 파일을 제공해야 합니다.
(`configSchema`, 비어 있더라도). 누락/잘못된 매니페스트 또는 스키마로 인해 방지
플러그인이 로드되지 않고 구성 유효성 검사에 실패합니다.

### 설치

```bash
openclaw plugins install <path-or-spec>
```

보안 참고 사항: 플러그인 설치를 코드 실행처럼 처리합니다. 고정된 버전을 선호하세요.

지원되는 아카이브: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

로컬 디렉터리 복사를 방지하려면 `--link`를 사용하세요(`plugins.load.paths`에 추가됨).

```bash
openclaw plugins install -l ./my-plugin
```

### 제거

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall`는 `plugins.entries`, `plugins.installs`에서 플러그인 레코드를 제거합니다.
해당되는 경우 플러그인 허용 목록 및 연결된 `plugins.load.paths` 항목.
활성 메모리 플러그인의 경우 메모리 슬롯이 `memory-core`로 재설정됩니다.

기본적으로 제거는 활성 폴더 아래의 플러그인 설치 디렉터리도 제거합니다.
상태 디렉토리 확장 루트(`$OPENCLAW_STATE_DIR/extensions/<id>`). 사용
`--keep-files` 디스크에 파일을 보관합니다.

`--keep-config`는 `--keep-files`에 대해 더 이상 사용되지 않는 별칭으로 지원됩니다.

### 업데이트

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

업데이트는 npm에서 설치된 플러그인에만 적용됩니다(`plugins.installs`에서 추적됨).
