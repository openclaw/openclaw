---
summary: "`openclaw plugins`에 대한 CLI 참조 (목록, 설치, 활성화/비활성화, doctor)"
read_when:
  - 인프로세스 Gateway(게이트웨이) 플러그인을 설치하거나 관리하려는 경우
  - 플러그인 로드 실패를 디버그하려는 경우
title: "plugins"
---

# `openclaw plugins`

Gateway(게이트웨이) 플러그인/확장(인프로세스 로드됨)을 관리합니다.

관련 항목:

- 플러그인 시스템: [Plugins](/tools/plugin)
- 플러그인 매니페스트 + 스키마: [Plugin manifest](/plugins/manifest)
- 보안 강화: [Security](/gateway/security)

## Commands

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

번들된 플러그인은 OpenClaw와 함께 제공되지만 기본적으로 비활성화되어 있습니다. `plugins enable`를 사용하여
이를 활성화하십시오.

모든 플러그인은 인라인 JSON Schema
(`configSchema`, 비어 있더라도)를 포함한 `openclaw.plugin.json` 파일을 제공해야 합니다. 매니페스트 또는 스키마가 없거나 유효하지 않으면
플러그인이 로드되지 않으며 설정 검증이 실패합니다.

### Install

```bash
openclaw plugins install <path-or-spec>
```

보안 참고 사항: 플러그인 설치는 코드 실행과 동일하게 취급하십시오. 고정된 버전을 사용하는 것을 권장합니다.

지원되는 아카이브: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

로컬 디렉토리를 복사하지 않으려면 `--link`를 사용하십시오(`plugins.load.paths`에 추가됩니다):

```bash
openclaw plugins install -l ./my-plugin
```

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

업데이트는 npm에서 설치된 플러그인(`plugins.installs`에 추적됨)에만 적용됩니다.
