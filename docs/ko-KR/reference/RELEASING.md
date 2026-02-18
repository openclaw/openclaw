---
title: "릴리스 체크리스트"
summary: "npm + macOS 앱에 대한 단계별 릴리스 체크리스트"
read_when:
  - 새로운 npm 릴리스 생성 시
  - 새로운 macOS 앱 릴리스 생성 시
  - 게시 전에 메타데이터 검증 시
---

# 릴리스 체크리스트 (npm + macOS)

리포지토리 루트에서 `pnpm` (Node 22+)을 사용하세요. 태그/게시 전에 작업 트리를 깨끗하게 유지하세요.

## 운영자 트리거

운영자가 "릴리스"라고 말할 때, 즉시 이 사전 점검을 수행하세요 (차단되는 경우를 제외하고 추가 질문 없이):

- 이 문서와 `docs/platforms/mac/release.md`를 읽으세요.
- `~/.profile`에서 환경을 로드하고 `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect 변수들이 설정되어 있는지 확인하세요 (`SPARKLE_PRIVATE_KEY_FILE`은 `~/.profile`에 있어야 합니다).
- 필요하다면 `~/Library/CloudStorage/Dropbox/Backup/Sparkle`에서 Sparkle 키를 사용하세요.

1. **버전 및 메타데이터**

- [ ] `package.json` 버전 올리기 (예: `2026.1.29`).
- [ ] `pnpm plugins:sync`를 실행하여 확장 패키지 버전 및 변경 로그를 정렬합니다.
- [ ] CLI / 버전 문자열 업데이트: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) 및 Baileys 사용자 에이전트를 [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts)에서 업데이트합니다.
- [ ] 패키지 메타데이터(이름, 설명, 리포지토리, 키워드, 라이선스) 및 `bin` 맵이 `openclaw.mjs`를 `openclaw`로 가리키는지 확인합니다.
- [ ] 종속성이 변경되었다면, `pnpm install`을 실행하여 `pnpm-lock.yaml`을 최신 상태로 만듭니다.

2. **빌드 및 아티팩트**

- [ ] A2UI 입력이 변경되었다면, `pnpm canvas:a2ui:bundle`을 실행하고 업데이트된 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)를 커밋합니다.
- [ ] `pnpm run build` (재생성 `dist/`).
- [ ] npm 패키지 `files`에 모든 필수 `dist/*` 폴더가 포함되어 있는지 확인합니다 (특히 무인 노드 및 ACP CLI를 위한 `dist/node-host/**` 및 `dist/acp/**`).
- [ ] `dist/build-info.json`이 존재하며 예상 `commit` 해시가 포함되어 있는지 확인합니다 (CLI 배너는 npm 설치에 이 정보를 사용합니다).
- [ ] 선택 사항: 빌드 후 `npm pack --pack-destination /tmp`을 실행하세요; tarball 내용을 검사하고 GitHub 릴리스에 대비해 준비해 두세요 (**커밋하지는 마세요**).

3. **변경 로그 및 문서**

- [ ] 사용자 대상의 하이라이트로 `CHANGELOG.md`를 업데이트하세요 (파일이 없다면 만드세요); 항목을 버전 순으로 내림차순으로 유지하세요.
- [ ] README 예제/플래그가 현재 CLI 동작에 맞도록 업데이트하세요 (특히 새로운 명령어나 옵션).

4. **검증**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (또는 커버리지 출력이 필요하다면 `pnpm test:coverage`)
- [ ] `pnpm release:check` (npm 패키지 내용을 검증합니다)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker 설치 간이 테스트, 빠른 경로; 릴리스 전에 필수)
  - 만약 직전의 npm 릴리스가 문제가 있는 것으로 알려져 있다면, 사전 설치 단계에서 `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 또는 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1`을 설정하세요.
- [ ] (선택 사항) 전체 설치 간이 테스트 (비 루트 및 CLI 커버리지 추가): `pnpm test:install:smoke`
- [ ] (선택 사항) 설치자 E2E (Docker, `curl -fsSL https://openclaw.ai/install.sh | bash`를 실행하고, 온보딩 후 실제 도구 호출 실행):
  - `pnpm test:install:e2e:openai` (`OPENAI_API_KEY` 필요)
  - `pnpm test:install:e2e:anthropic` (`ANTHROPIC_API_KEY` 필요)
  - `pnpm test:install:e2e` (두 키 모두 필요; 두 프로바이더 실행)
- [ ] (선택 사항) 변경 사항이 송수신 경로에 영향을 미치는 경우 웹 게이트웨이를 점검하세요.

5. **macOS 앱 (Sparkle)**

- [ ] macOS 앱을 빌드하고 서명한 후 배포를 위해 압축하세요.
- [ ] Sparkle 앱캐스트 생성 (HTML 노트는 [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)를 통해) 및 `appcast.xml`을 업데이트하세요.
- [ ] 앱 압축 파일 및 선택적 dSYM 압축 파일을 GitHub 릴리스에 첨부할 준비를 하세요.
- [ ] 정확한 명령어 및 필요한 환경 변수를 위해 [macOS 릴리스](/platforms/mac/release)를 따르세요.
  - `APP_BUILD`는 버전 비교가 제대로 이루어지도록 숫자 및 단조 증가해야 합니다 (no `-beta`).
  - 공증을 하는 경우, App Store Connect API 환경 변수에서 생성된 `openclaw-notary` 키체인 프로파일을 사용하세요 ([macOS 릴리스](/platforms/mac/release) 참조).

6. **게시 (npm)**

- [ ] git 상태가 깨끗한지 확인하고 필요한 경우 커밋 및 푸시하세요.
- [ ] 필요한 경우 `npm login` (2FA 확인).
- [ ] `npm publish --access public` (사전 릴리스에는 `--tag beta`를 사용).
- [ ] 레지스트리 확인: `npm view openclaw version`, `npm view openclaw dist-tags`, 그리고 `npx -y openclaw@X.Y.Z --version` (또는 `--help`).

### 문제 해결 (2.0.0-beta2 릴리스의 노트에서)

- **npm pack/publish가 멈추거나 큰 tarball을 생성함**: `dist/OpenClaw.app` 내의 macOS 앱 번들 (및 릴리스 zip 파일)이 패키지에 포함됩니다. 게시 내용을 `package.json` `files`를 통해 화이트리스트로 관리해 해결하세요 (`dist` 하위 디렉토리, 문서, 스킬 포함; 앱 번들 제외). `npm pack --dry-run`으로 `dist/OpenClaw.app`가 목록에 나오지 않는지 확인하세요.
- **`dist-tags`에 대한 npm 인증 웹 루프**: OTP 프롬프트를 얻기 위해 레거시 인증을 사용하세요:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` 인증 실패 및 `ECOMPROMISED: Lock compromised` 에러**: 새로운 캐시로 다시 시도:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **늦은 수정 후 태그가 재지정 필요**: 태그를 강제 업데이트 및 푸시하고, GitHub 릴리스 에셋이 여전히 맞는지 확인하세요:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub 릴리스 + 앱캐스트**

- [ ] 태그 및 푸시: `git tag vX.Y.Z && git push origin vX.Y.Z` (또는 `git push --tags`).
- [ ] `vX.Y.Z`에 대한 GitHub 릴리스를 생성/새로 고침하며 **제목 `openclaw X.Y.Z`**을 사용하세요 (단순 태그명이 아닌); 본문은 해당 버전에 대한 **전체** 변경 로그 섹션을 포함해야 하며 (하이라이트 + 변경사항 + 수정사항) 인라인으로 제공되며, **본문에 제목을 반복해서는 안 됩니다**.
- [ ] 아티팩트 첨부: `npm pack` tarball (선택적), `OpenClaw-X.Y.Z.zip`, 및 `OpenClaw-X.Y.Z.dSYM.zip` (생성된 경우).
- [ ] 업데이트된 `appcast.xml`을 커밋하고 푸시하세요 (Sparkle은 메인에서 공급됩니다).
- [ ] 깨끗한 임시 디렉토리에서 (no `package.json`), `npx -y openclaw@X.Y.Z send --help`를 실행하여 설치/CLI 진입점이 동작하는지 확인합니다.
- [ ] 릴리스 노트를 발표/공유하세요.

## 플러그인 출판 범위 (npm)

우리는 **기존 npm 플러그인**만을 `@openclaw/*` 범위 아래에 게시합니다. npm에 없는 번들 플러그인은 여전히 **디스크 트리만** 남겨두며 (`extensions/**`에서 여전히 제공됨).

리스트를 도출하는 과정:

1. `npm search @openclaw --json`을 사용하여 패키지 이름을 캡처합니다.
2. `extensions/*/package.json` 이름과 비교합니다.
3. **교집합**만 게시 (이미 npm에 있는 것들).

현재 npm 플러그인 목록 (필요 시 업데이트):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

릴리스 노트는 또한 **기본적으로 활성화되지 않은** 새로운 선택적 번들 플러그인을 언급해야 합니다 (예: `tlon`).
