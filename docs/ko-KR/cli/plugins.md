---
summary: "CLI reference for `openclaw plugins` (list, install, uninstall, enable/disable, doctor)"
read_when:
  - 인프로세스 게이트웨이 플러그인을 설치하거나 관리하고 싶을 때
  - 플러그인 로드 실패를 디버그하고 싶을 때
title: "plugins"
---

# `openclaw plugins`

Manage Gateway plugins/extensions (loaded in-process).

Related:

- Plugin system: [Plugins](/ko-KR/tools/plugin)
- Plugin manifest + schema: [Plugin manifest](/ko-KR/plugins/manifest)
- Security hardening: [Security](/ko-KR/gateway/security)

## Commands

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

Bundled plugins ship with OpenClaw but start disabled. Use `plugins enable` to
activate them.

All plugins must ship a `openclaw.plugin.json` file with an inline JSON Schema
(`configSchema`, even if empty). Missing/invalid manifests or schemas prevent
the plugin from loading and fail config validation.

### Install

```bash
openclaw plugins install <path-or-spec>
openclaw plugins install <npm-spec> --pin
```

Security note: treat plugin installs like running code. Prefer pinned versions.

Npm specs are **registry-only** (package name + optional version/tag). Git/URL/file
specs are rejected. Dependency installs run with `--ignore-scripts` for safety.

Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.

Use `--link` to avoid copying a local directory (adds to `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

npm 설치 시 `--pin`을 사용하면 해결된 정확한 스펙(`name@version`)이
`plugins.installs`에 저장되며, 기본 동작은 고정되지 않습니다.

### Uninstall

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
```

`uninstall`는 `plugins.entries`, `plugins.installs`, 플러그인 허용 목록 및 관련된 `plugins.load.paths` 항목에서 플러그인 기록을 제거합니다. 활성 메모리 플러그인의 경우, 메모리 슬롯은 `memory-core`로 재설정됩니다.

기본적으로, uninstall은 활성 상태 디렉토리 확장 루트(`$OPENCLAW_STATE_DIR/extensions/<id>`) 아래의 플러그인 설치 디렉토리도 제거합니다. 파일을 유지하려면 `--keep-files`를 사용하십시오.

`--keep-config`는 `--keep-files`의 폐기된 별칭으로 지원됩니다.

### Update

```bash
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins update <id> --dry-run
```

Updates only apply to plugins installed from npm (tracked in `plugins.installs`).

저장된 무결성 해시가 존재하고 가져온 아티팩트 해시가 변경되면,
OpenClaw는 경고를 출력하고 진행하기 전에 확인을 요청합니다. CI/비대화형 실행에서는
전역 `--yes` 플래그를 사용하여 프롬프트를 건너뛰세요.
