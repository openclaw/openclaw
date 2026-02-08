---
read_when:
    - 진행 중인 게이트웨이 플러그인을 설치하거나 관리하려는 경우
    - 플러그인 로드 실패를 디버깅하고 싶습니다.
summary: '`openclaw plugins`에 대한 CLI 참조(목록, 설치, 활성화/비활성화, 의사)'
title: 플러그인
x-i18n:
    generated_at: "2026-02-08T15:51:06Z"
    model: gtx
    provider: google-translate
    source_hash: 60476e0a9b7247bda6484262a829142a52124485940a20e5cda9ac663e1bee16
    source_path: cli/plugins.md
    workflow: 15
---

# `openclaw plugins`

게이트웨이 플러그인/확장(프로세스 내 로드됨)을 관리합니다.

관련된:

- 플러그인 시스템: [플러그인](/tools/plugin)
- 플러그인 매니페스트 + 스키마: [플러그인 매니페스트](/plugins/manifest)
- 보안 강화: [보안](/gateway/security)

## 명령

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
openclaw plugins update <id>
openclaw plugins update --all
```

번들 플러그인은 OpenClaw와 함께 제공되지만 시작은 비활성화됩니다. 사용 `plugins enable` 에
활성화하십시오.

모든 플러그인은 `openclaw.plugin.json` 인라인 JSON 스키마가 있는 파일
(`configSchema`, 비어 있더라도). 누락/잘못된 매니페스트 또는 스키마로 인해 방지
플러그인이 로드되지 않고 구성 유효성 검사에 실패합니다.

### 설치하다

```bash
openclaw plugins install <path-or-spec>
```

보안 참고 사항: 플러그인 설치를 코드 실행처럼 처리합니다. 고정된 버전을 선호하세요.

지원되는 아카이브: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

사용 `--link` 로컬 디렉토리 복사를 피하기 위해 (에 추가 `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

### 업데이트

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

업데이트는 npm에서 설치된 플러그인에만 적용됩니다(추적 위치: `plugins.installs`).
