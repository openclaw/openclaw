---
title: "Release Checklist"
summary: "Step-by-step release checklist for npm + macOS app"
read_when:
  - Cutting a new npm release
  - Cutting a new macOS app release
  - Verifying metadata before publishing
x-i18n:
  source_hash: ad0e10874266c6556759ec56fbb5d192191b0f6df4543431d4fe1b378375d19a
---

# 릴리스 체크리스트(npm + macOS)

repo 루트에서 `pnpm` (노드 22+)를 사용합니다. 태그를 지정/게시하기 전에 작업 트리를 깨끗하게 유지하세요.

## 연산자 트리거

운영자가 "해제"라고 말하면 즉시 다음 사전 비행을 수행합니다(차단되지 않는 한 추가 질문 없음).

- 이 문서와 `docs/platforms/mac/release.md`를 읽어보세요.
- `~/.profile`에서 환경을 로드하고 `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect 변수가 설정되었는지 확인합니다(SPARKLE_PRIVATE_KEY_FILE은 `~/.profile`에 있어야 함).
- 필요한 경우 `~/Library/CloudStorage/Dropbox/Backup/Sparkle`의 스파클 키를 사용하세요.

1. **버전 및 메타데이터**

- [ ] 범프 `package.json` 버전(예: `2026.1.29`).
- [ ] `pnpm plugins:sync`를 실행하여 확장 패키지 버전과 변경 로그를 정렬합니다.
- [ ] CLI/버전 문자열: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) 및 [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts)의 Baileys 사용자 에이전트를 업데이트합니다.
- [ ] 패키지 메타데이터(이름, 설명, 저장소, 키워드, 라이선스)와 `bin` 맵이 `openclaw`에 대한 [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)를 가리키는지 확인합니다.
- [ ] 종속성이 변경된 경우 `pnpm install`를 실행하여 `pnpm-lock.yaml`가 현재 버전이 되도록 합니다.

2. **빌드 및 아티팩트**

- [ ] A2UI 입력이 변경된 경우 `pnpm canvas:a2ui:bundle`를 실행하고 업데이트된 모든 [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js)를 커밋합니다.
- [ ] `pnpm run build` (`dist/`를 재생성함).
- [ ] npm 패키지 `files`에 필요한 모든 `dist/*` 폴더(특히 헤드리스 노드 + ACP CLI의 경우 `dist/node-host/**` 및 `dist/acp/**`)가 포함되어 있는지 확인합니다.
- [ ] `dist/build-info.json`가 존재하고 예상되는 `commit` 해시가 포함되어 있는지 확인합니다(CLI 배너는 npm 설치에 이것을 사용합니다).
- [ ] 선택 사항: `npm pack --pack-destination /tmp` 빌드 후; tarball 내용을 검사하고 GitHub 릴리스에 편리하게 보관하십시오(커밋하지 **않음**).

3. **변경 로그 및 문서**

- [ ] 사용자에게 표시되는 하이라이트로 `CHANGELOG.md`를 업데이트합니다(누락된 경우 파일 생성). 항목을 버전별로 엄격하게 내림차순으로 유지합니다.
- [ ] README 예제/플래그가 현재 CLI 동작(특히 새 명령 또는 옵션)과 일치하는지 확인하십시오.

4. **검증**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (또는 적용 범위 출력이 필요한 경우 `pnpm test:coverage`)
- [ ] `pnpm release:check` (npm 팩 내용 확인)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker 설치 스모크 테스트, 빠른 경로, 출시 전 필요)
  - 직전 npm 릴리스가 손상된 것으로 알려진 경우 사전 설치 단계에 대해 `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 또는 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1`를 설정합니다.
- [ ] (선택 사항) 전체 설치 프로그램 연기(비루트 + CLI 적용 범위 추가): `pnpm test:install:smoke`
- [ ] (선택 사항) 설치 프로그램 E2E(Docker, `curl -fsSL https://openclaw.ai/install.sh | bash` 실행, 온보드 후 실제 도구 호출 실행):
  - `pnpm test:install:e2e:openai` (`OPENAI_API_KEY` 필요)
  - `pnpm test:install:e2e:anthropic` (`ANTHROPIC_API_KEY` 필요)
  - `pnpm test:install:e2e` (두 키가 모두 필요하며 두 공급자 모두 실행)
- [ ] (선택 사항) 변경 사항이 전송/수신 경로에 영향을 미치는 경우 웹 게이트웨이를 즉시 확인합니다.

5. **macOS 앱(Sparkle)**

- [ ] macOS 앱을 빌드하고 서명한 다음 배포용으로 압축합니다.
- [ ] Sparkle appcast([`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)를 통해 HTML 노트)를 생성하고 `appcast.xml`를 업데이트합니다.
- [ ] GitHub 릴리스에 연결할 수 있도록 앱 zip(및 선택적 dSYM zip)을 준비하세요.
- [ ] 정확한 명령과 필요한 환경 변수는 [macOS 릴리스](/platforms/mac/release)를 따르세요.
  - `APP_BUILD`는 숫자 + 단조(`-beta` 없음)여야 하므로 Sparkle은 버전을 올바르게 비교합니다.
  - 공증하는 경우 App Store Connect API 환경 변수에서 생성된 `openclaw-notary` 키체인 프로필을 사용합니다([macOS 릴리스](/platforms/mac/release) 참조).

6. **게시(npm)**

- [ ] Git 상태가 깨끗한지 확인합니다. 필요에 따라 커밋하고 푸시합니다.
- [ ] `npm login` (2FA 확인) 필요한 경우.
- [ ] `npm publish --access public` (사전 출시의 경우 `--tag beta` 사용).
- [ ] 레지스트리를 확인합니다: `npm view openclaw version`, `npm view openclaw dist-tags` 및 `npx -y openclaw@X.Y.Z --version`(또는 `--help`).

### 문제 해결(2.0.0-beta2 릴리스의 참고 사항)

- **npm pack/publish가 중단되거나 거대한 타르볼을 생성합니다**: `dist/OpenClaw.app`(및 릴리스 zip)의 macOS 앱 번들이 패키지에 포함됩니다. `package.json` `files`를 통해 게시 콘텐츠를 화이트리스트에 등록하여 문제를 해결합니다(dist 하위 디렉터리, 문서, 기술 포함, 앱 번들 제외). `dist/OpenClaw.app`가 목록에 없는지 `npm pack --dry-run`로 확인하세요.
- **dist-tags에 대한 npm 인증 웹 루프**: 레거시 인증을 사용하여 OTP 프롬프트를 얻습니다.
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` 확인이 `ECOMPROMISED: Lock compromised`**로 인해 실패합니다. 새로운 캐시로 다시 시도하세요.
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **최신 수정 후 태그를 다시 지정해야 함**: 강제 업데이트하고 태그를 푸시한 다음 GitHub 릴리스 자산이 여전히 일치하는지 확인하세요.
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub 릴리스 + 앱캐스트**

- [ ] 태그를 지정하고 푸시합니다: `git tag vX.Y.Z && git push origin vX.Y.Z`(또는 `git push --tags`).
- [ ] **제목 `openclaw X.Y.Z`**(태그뿐만 아니라)로 `vX.Y.Z`에 대한 GitHub 릴리스를 생성/새로 고칩니다. 본문에는 해당 버전에 대한 **전체** 변경 로그 섹션(하이라이트 + 변경 사항 + 수정 사항), 인라인(기본 링크 없음)이 포함되어야 하며 **본문 내부에서 제목을 반복해서는 안 됩니다**.
- [ ] 아티팩트 첨부: `npm pack` 타르볼(선택 사항), `OpenClaw-X.Y.Z.zip` 및 `OpenClaw-X.Y.Z.dSYM.zip`(생성된 경우).
- [ ] 업데이트된 `appcast.xml`를 커밋하고 푸시합니다(Sparkle은 메인에서 피드).
- [ ] 깨끗한 임시 디렉터리(`package.json` 없음)에서 `npx -y openclaw@X.Y.Z send --help`를 실행하여 설치/CLI 진입점이 작동하는지 확인합니다.
- [ ] 릴리스 노트를 발표/공유합니다.

## 플러그인 게시 범위(npm)

우리는 `@openclaw/*` 범위에 **기존 npm 플러그인**만 게시합니다. 번들로 제공
npm에 없는 플러그인은 **디스크 트리만** 유지됩니다(계속 배송됨)
`extensions/**`).

목록을 도출하는 프로세스:

1. `npm search @openclaw --json` 패키지 이름을 캡처합니다.
2. `extensions/*/package.json` 이름과 비교해보세요.
3. **교차로**만 게시합니다(이미 npm에 있음).

현재 npm 플러그인 목록(필요에 따라 업데이트):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/랍스터
- @openclaw/매트릭스
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/음성통화
- @openclaw/zalo
- @openclaw/zalouser

출시 노트에는 **아닌 **새로운 선택적 번들 플러그인**도 명시되어야 합니다.
기본적으로 켜져 있습니다**(예: `tlon`).
