---
read_when:
    - 새로운 npm 릴리스 자르기
    - 새로운 macOS 앱 출시 중단
    - 게시하기 전에 메타데이터 확인
summary: npm + macOS 앱의 단계별 릴리스 체크리스트
x-i18n:
    generated_at: "2026-02-08T16:02:09Z"
    model: gtx
    provider: google-translate
    source_hash: 54cb2b822bfa3c0bf5910d22273fa70380c02b9a30122c9ea225ec61ece68ea1
    source_path: reference/RELEASING.md
    workflow: 15
---

# 릴리스 체크리스트(npm + macOS)

사용 `pnpm` (노드 22+) 저장소 루트에서. 태그를 지정/게시하기 전에 작업 트리를 깨끗하게 유지하세요.

## 운영자 트리거

운영자가 "해제"라고 말하면 즉시 다음 사전 비행을 수행합니다(차단되지 않는 한 추가 질문 없음).

- 이 문서를 읽고 `docs/platforms/mac/release.md`.
- 다음에서 환경 로드 `~/.profile` 확인하고 `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect 변수가 설정되었습니다(SPARKLE_PRIVATE_KEY_FILE은 `~/.profile`).
- Sparkle 키 사용 `~/Library/CloudStorage/Dropbox/Backup/Sparkle` 필요한 경우.

1. **버전 및 메타데이터**

- [ ] 충돌 `package.json` 버전(예: `2026.1.29`).
- [ ] 달리다 `pnpm plugins:sync` 확장 패키지 버전 + 변경 로그를 정렬합니다.
- [ ] CLI/버전 문자열 업데이트: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) Baileys 사용자 에이전트는 다음과 같습니다. [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).
- [ ] 패키지 메타데이터(이름, 설명, 저장소, 키워드, 라이선스)를 확인하고 `bin` 지도는 다음을 가리킨다 [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) ~을 위한 `openclaw`.
- [ ] 종속성이 변경된 경우 다음을 실행하세요. `pnpm install` 그래서 `pnpm-lock.yaml` 현재입니다.

2. **빌드 및 아티팩트**

- [ ] A2UI 입력이 변경된 경우 다음을 실행하십시오. `pnpm canvas:a2ui:bundle` 업데이트된 내용을 커밋합니다. [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (재생 `dist/`).
- [ ] npm 패키지 확인 `files` 필요한 모든 것을 포함합니다 `dist/*` 폴더(특히 `dist/node-host/**` 그리고 `dist/acp/**` 헤드리스 노드 + ACP CLI의 경우).
- [ ] 확인하다 `dist/build-info.json` 존재하며 예상되는 내용을 포함합니다. `commit` 해시(CLI 배너는 npm 설치에 이를 사용합니다).
- [ ] 선택 과목: `npm pack --pack-destination /tmp` 빌드 후; tarball 내용을 검사하고 GitHub 릴리스에 편리하게 보관하십시오( **~ 아니다** 커밋합니다).

3. **변경 로그 및 문서**

- [ ] 업데이트 `CHANGELOG.md` 사용자에게 표시되는 하이라이트 포함(누락된 경우 파일 생성) 항목을 버전별로 엄격하게 내림차순으로 유지합니다.
- [ ] README 예제/플래그가 현재 CLI 동작(특히 새 명령 또는 옵션)과 일치하는지 확인하세요.

4. **확인**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (또는 `pnpm test:coverage` 적용 범위 출력이 필요한 경우)
- [ ] `pnpm release:check` (npm 팩 내용 확인)
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker 설치 스모크 테스트, 빠른 경로, 출시 전 필수)
  - 직전 npm 릴리스가 손상된 것으로 알려진 경우 다음을 설정하십시오. `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` 또는 `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` 사전 설치 단계의 경우
- [ ] (선택 사항) 전체 설치 프로그램 연기(비루트 + CLI 적용 범위 추가): `pnpm test:install:smoke`
- [ ] (선택 사항) 설치 프로그램 E2E(Docker, 실행 `curl -fsSL https://openclaw.ai/install.sh | bash`, 온보드한 후 실제 도구 호출을 실행합니다.)
  - `pnpm test:install:e2e:openai` (요구 `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (요구 `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (두 키가 모두 필요하며 두 공급자 모두 실행)
- [ ] (선택 사항) 변경 사항이 전송/수신 경로에 영향을 미치는 경우 웹 게이트웨이를 즉시 확인하세요.

5. **macOS 앱(스파클)**

- [ ] macOS 앱을 빌드하고 서명한 다음 배포용으로 압축합니다.
- [ ] Sparkle appcast 생성(HTML 노트를 통해 [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) 및 업데이트 `appcast.xml`.
- [ ] GitHub 릴리스에 연결할 수 있도록 앱 zip(및 선택적 dSYM zip)을 준비하세요.
- [ ] 따르다 [macOS 릴리스](/platforms/mac/release) 정확한 명령과 필수 환경 변수를 확인하세요.
  - `APP_BUILD` 숫자 + 단조적이어야 합니다(아니요 `-beta`) 따라서 Sparkle은 버전을 올바르게 비교합니다.
  - 공증을 받는 경우 다음을 사용하세요. `openclaw-notary` App Store Connect API 환경 변수에서 생성된 키체인 프로필(참조 [macOS 릴리스](/platforms/mac/release)).

6. **게시(npm)**

- [ ] Git 상태가 깨끗한지 확인하세요. 필요에 따라 커밋하고 푸시합니다.
- [ ] `npm login` (2FA 확인) 필요한 경우.
- [ ] `npm publish --access public` (사용 `--tag beta` 시험판의 경우).
- [ ] 레지스트리를 확인합니다. `npm view openclaw version`, `npm view openclaw dist-tags`, 그리고 `npx -y openclaw@X.Y.Z --version` (또는 `--help`).

### 문제 해결(2.0.0-beta2 릴리스의 참고 사항)

- **npm pack/publish가 중단되거나 거대한 타르볼을 생성합니다.**: macOS 앱 번들 `dist/OpenClaw.app` (및 릴리스 zip)이 패키지에 휩쓸려 들어갑니다. 다음을 통해 콘텐츠 게시를 허용하여 문제를 해결하세요. `package.json` `files` (dist 하위 디렉터리, 문서, 기술 포함, 앱 번들 제외) 확인 `npm pack --dry-run` 저것 `dist/OpenClaw.app` 목록에 없습니다.
- **dist-tag에 대한 npm 인증 웹 루프**: 레거시 인증을 사용하여 OTP 프롬프트를 받습니다.
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` 확인 실패 `ECOMPROMISED: Lock compromised`**: 새로운 캐시로 다시 시도하세요.
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **늦은 수정 후 태그를 다시 지정해야 함**: 태그를 강제 업데이트하고 푸시한 후 GitHub 릴리스 자산이 여전히 일치하는지 확인하세요.
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`

7. **GitHub 릴리스 + 앱캐스트**

- [ ] 태그 및 푸시: `git tag vX.Y.Z && git push origin vX.Y.Z` (또는 `git push --tags`).
- [ ] GitHub 릴리스 생성/새로 고침 `vX.Y.Z` ~와 함께 **제목 `openclaw X.Y.Z`** (태그뿐만 아니라); 본문에는 다음이 포함되어야 합니다. **가득한** 해당 버전에 대한 변경 로그 섹션(하이라이트 + 변경 사항 + 수정 사항), 인라인(기본 링크 없음) 및 **본문 내에서 제목을 반복하면 안 됩니다.**.
- [ ] 아티팩트 첨부: `npm pack` 타르볼(선택 사항), `OpenClaw-X.Y.Z.zip`, 그리고 `OpenClaw-X.Y.Z.dSYM.zip` (생성된 경우).
- [ ] 업데이트된 내용을 커밋 `appcast.xml` 그리고 밀어 넣으세요(Sparkle은 메인에서 피드됩니다).
- [ ] 깨끗한 임시 디렉터리에서(아니요 `package.json`), 달리다 `npx -y openclaw@X.Y.Z send --help` 설치/CLI 진입점이 작동하는지 확인합니다.
- [ ] 릴리스 노트를 발표/공유합니다.

## 플러그인 게시 범위(npm)

우리는 출판만 합니다 **기존 npm 플러그인** 아래에 `@openclaw/*` 범위. 번들로 제공
npm stay에 없는 플러그인 **디스크 트리만** (아직 배송중
`extensions/**`).

목록을 도출하는 프로세스:

1. `npm search @openclaw --json` 패키지 이름을 캡처합니다.
2. 비교 `extensions/*/package.json` 이름.
3. 만 게시 **교차로** (이미 npm에 있습니다).

현재 npm 플러그인 목록(필요에 따라 업데이트):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/불화
- @openclaw/페이슈
- @오픈클로/랍스터
- @오픈클로/매트릭스
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/음성통화
- @openclaw/zalo
- @openclaw/zalouser

릴리스 노트에도 명시해야 합니다. **새로운 선택적 번들 플러그인** 그건 **아니
기본적으로 켜져 있음** (예: `tlon`).
