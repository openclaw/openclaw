---
summary: "npm + macOS 앱을 위한 단계별 릴리스 체크리스트"
read_when:
  - 새로운 npm 릴리스를 진행할 때
  - 새로운 macOS 앱 릴리스를 진행할 때
  - 게시 전 메타데이터를 검증할 때
---

# 릴리스 체크리스트 (npm + macOS)

리포지토리 루트에서 `pnpm` (Node 22+)를 사용합니다. 태깅/게시 전에 작업 트리를 깨끗하게 유지합니다.

## 운영자 트리거

운영자가 “release”라고 말하면, 차단되는 경우가 아니라면 추가 질문 없이 즉시 다음 사전 점검을 수행합니다.

- 이 문서와 `docs/platforms/mac/release.md`을 읽습니다.
- `~/.profile`에서 환경 변수를 로드하고 `SPARKLE_PRIVATE_KEY_FILE` 및 App Store Connect 변수들이 설정되어 있는지 확인합니다 (SPARKLE_PRIVATE_KEY_FILE 은 `~/.profile`에 있어야 합니다).
- 필요 시 `~/Library/CloudStorage/Dropbox/Backup/Sparkle`의 Sparkle 키를 사용합니다.

1. **버전 및 메타데이터**

- [ ] `package.json` 버전을 올립니다 (예: `2026.1.29`).
- [ ] `pnpm plugins:sync`을 실행하여 확장 패키지 버전과 변경 로그를 정렬합니다.
- [ ] CLI/버전 문자열을 업데이트합니다: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) 및 [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts)의 Baileys 사용자 에이전트.
- [ ] 패키지 메타데이터(이름, 설명, 저장소, 키워드, 라이선스)를 확인하고, `bin` 맵이 `openclaw`에 대해 [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)를 가리키는지 확인합니다.
- [ ] 의존성이 변경되었다면 `pnpm install`를 실행하여 `pnpm-lock.yaml`가 최신인지 확인합니다.

2. **빌드 및 산출물**

- [ ] A2UI 입력이 변경되었다면 `pnpm canvas:a2ui:bundle`을 실행하고 업데이트된 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)를 커밋합니다.
- [ ] `pnpm run build` ( `dist/`를 재생성합니다).
- [ ] npm 패키지 `files`에 필요한 모든 `dist/*` 폴더가 포함되어 있는지 확인합니다 (특히 헤드리스 노드 + ACP CLI 용 `dist/node-host/**` 및 `dist/acp/**`).
- [ ] `dist/build-info.json`가 존재하며 예상되는 `commit` 해시를 포함하는지 확인합니다 (CLI 배너가 npm 설치 시 이를 사용합니다).
- [ ] 선택 사항: 빌드 후 `npm pack --pack-destination /tmp`을 실행하여 tarball 내용을 검사하고 GitHub 릴리스에 사용할 수 있도록 보관합니다 (**커밋하지 마십시오**).

3. **변경 로그 및 문서**

- [ ] 사용자에게 노출되는 하이라이트로 `CHANGELOG.md`를 업데이트합니다 (없다면 파일을 생성합니다). 항목은 버전 기준으로 엄격히 내림차순을 유지합니다.
- [ ] README 예제/플래그가 현재 CLI 동작과 일치하는지 확인합니다 (특히 새로운 명령이나 옵션).

4. **검증**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (또는 커버리지 출력이 필요하면 `pnpm test:coverage`)
- [ ] `pnpm release:check` (npm pack 내용 검증)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker 설치 스모크 테스트, 빠른 경로; 릴리스 전 필수)
  - 직전 npm 릴리스가 문제가 있는 것으로 알려진 경우, 사전 설치 단계에서 `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 또는 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1`를 설정합니다.
- [ ] (선택 사항) 전체 설치 스모크(비루트 + CLI 커버리지 추가): `pnpm test:install:smoke`
- [ ] (선택 사항) 설치 E2E(Docker, `curl -fsSL https://openclaw.ai/install.sh | bash` 실행, 온보딩 후 실제 도구 호출 실행):
  - `pnpm test:install:e2e:openai` (`OPENAI_API_KEY` 필요)
  - `pnpm test:install:e2e:anthropic` (`ANTHROPIC_API_KEY` 필요)
  - `pnpm test:install:e2e` (두 키 모두 필요; 두 프로바이더 실행)
- [ ] (선택 사항) 변경 사항이 송수신 경로에 영향을 주는 경우 웹 Gateway(게이트웨이)를 스폿 체크합니다.

5. **macOS 앱 (Sparkle)**

- [ ] macOS 앱을 빌드 및 서명한 후 배포용으로 zip 합니다.
- [ ] Sparkle appcast 를 생성하고(HTML 노트는 [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh) 사용) `appcast.xml`를 업데이트합니다.
- [ ] 앱 zip (및 선택 사항인 dSYM zip)을 GitHub 릴리스에 첨부할 수 있도록 준비합니다.
- [ ] 정확한 명령과 필요한 환경 변수는 [macOS release](/platforms/mac/release)를 따릅니다.
  - `APP_BUILD`는 숫자형이며 단조 증가해야 합니다 (`-beta` 금지). 그래야 Sparkle 이 버전을 올바르게 비교합니다.
  - 공증을 수행하는 경우 App Store Connect API 환경 변수로 생성한 `openclaw-notary` 키체인 프로파일을 사용합니다 ([macOS release](/platforms/mac/release) 참조).

6. **게시 (npm)**

- [ ] git 상태가 깨끗한지 확인하고, 필요 시 커밋 및 푸시합니다.
- [ ] 필요 시 `npm login` (2FA 확인).
- [ ] `npm publish --access public` (프리릴리스에는 `--tag beta` 사용).
- [ ] 레지스트리를 확인합니다: `npm view openclaw version`, `npm view openclaw dist-tags`, 및 `npx -y openclaw@X.Y.Z --version` (또는 `--help`).

### 문제 해결 (2.0.0-beta2 릴리스의 메모)

- **npm pack/publish 가 멈추거나 매우 큰 tarball 을 생성함**: `dist/OpenClaw.app`의 macOS 앱 번들(및 릴리스 zip)이 패키지에 포함됩니다. `package.json` `files`로 게시 콘텐츠를 화이트리스트하여 수정합니다 (dist 하위 디렉토리, docs, skills 포함; 앱 번들 제외). `npm pack --dry-run`로 `dist/OpenClaw.app`가 목록에 없는지 확인합니다.
- **dist-tags 에서 npm 인증 웹 루프**: OTP 프롬프트를 받기 위해 레거시 인증을 사용합니다:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` 검증이 `ECOMPROMISED: Lock compromised`로 실패함**: 새 캐시로 재시도합니다:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **늦은 수정 후 태그 재지정이 필요함**: 태그를 강제로 업데이트하고 푸시한 다음, GitHub 릴리스 자산이 여전히 일치하는지 확인합니다:
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub 릴리스 + appcast**

- [ ] 태그 지정 및 푸시: `git tag vX.Y.Z && git push origin vX.Y.Z` (또는 `git push --tags`).
- [ ] `vX.Y.Z`에 대한 GitHub 릴리스를 생성/갱신하고 \*\*제목은 `openclaw X.Y.Z`\*\*로 설정합니다(태그만 사용하지 마십시오). 본문에는 해당 버전의 **전체** 변경 로그 섹션(Highlights + Changes + Fixes)을 인라인으로 포함해야 하며(단순 링크 금지), **본문에 제목을 반복해서는 안 됩니다**.
- [ ] 산출물을 첨부합니다: `npm pack` tarball (선택 사항), `OpenClaw-X.Y.Z.zip`, 및 `OpenClaw-X.Y.Z.dSYM.zip` (생성된 경우).
- [ ] 업데이트된 `appcast.xml`를 커밋하고 푸시합니다 (Sparkle 은 main 에서 피드를 가져옵니다).
- [ ] 깨끗한 임시 디렉토리(`package.json` 없음)에서 `npx -y openclaw@X.Y.Z send --help`를 실행하여 설치/CLI 진입점이 정상 동작하는지 확인합니다.
- [ ] 릴리스 노트를 공지/공유합니다.

## 플러그인 게시 범위 (npm)

우리는 `@openclaw/*` 스코프 아래의 **기존 npm 플러그인**만 게시합니다. npm 에 없는 번들 플러그인은 **디스크 트리 전용**으로 유지됩니다(여전히 `extensions/**`에 포함되어 배포됨).

목록을 도출하는 과정:

1. `npm search @openclaw --json`를 실행하고 패키지 이름을 수집합니다.
2. `extensions/*/package.json` 이름과 비교합니다.
3. **교집합**(이미 npm 에 존재하는 것)만 게시합니다.

현재 npm 플러그인 목록(필요 시 업데이트):

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

릴리스 노트에는 기본값으로 켜져 있지 않은 **새로운 선택적 번들 플러그인**도 반드시 명시해야 합니다(예: `tlon`).
