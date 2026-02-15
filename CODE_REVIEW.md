# Code Review: Recent Security & Maintenance Commits

**Reviewed commits:** `b796f6e` → `411d5fd` (5 commits)
**Reviewer:** Claude Opus 4.5
**Date:** 2026-02-02

---

## 1. `411d5fd` — fix(tlon): add timeout to SSE client fetch calls (CWE-400)

**Severity:** High (CWE-400: Uncontrolled Resource Consumption)
**Rating:** Good

### Summary
Urbit SSE 클라이언트의 모든 fetch 호출에 타임아웃을 추가하여, 서버 무응답 시 무한 대기(hang)를 방지.

### Positive
- 일반 요청(one-shot)에는 `AbortSignal.timeout(30_000)`, SSE 스트림에는 `AbortController` + 60초 수동 타임아웃 적용 — 적절한 이원 전략.
- SSE 스트림은 헤더 수신 후 `clearTimeout()`으로 타임아웃 해제 — 활성 스트림이 중단되지 않음.
- `close()` 메서드의 unsubscribe/DELETE 호출에도 타임아웃 적용하여 종료 시에도 hang 방지.

### Issues

**[Medium] `openStream()` 타임아웃 abort 시 에러 메시지 부족**
`controller.abort()`가 호출되면 fetch가 `AbortError`를 throw하지만, 이 에러에는 "connection timeout" 같은 context가 없음. `controller.abort(new Error("SSE connection timeout (60s)"))` 형태로 abort reason을 전달하면 디버깅에 도움됨.

**[Low] `openStream()`이 `public` 접근자 — 직접 호출 시 `isConnected` 미설정**
`openStream()`은 `connect()` 내부에서 호출되어야 하는데, public이라 직접 호출할 경우 `isConnected = true`가 설정되지 않음. `private`으로 변경하거나 내부에서 상태를 설정하는 것이 안전.

**[Low] 타임아웃 상수가 하드코딩됨**
30초/60초가 매직넘버로 사용됨. `constructor` options로 설정 가능하게 하거나 최소한 `static readonly` 상수로 추출하면 유지보수성 향상.

---

## 2. `19775ab` — fix: clean up plugin linting and types

**Severity:** Low (maintenance)
**Rating:** Good

### Summary
oxlint 규칙 추가 (`no-redundant-type-constituents` off), Google Chat 플러그인에서 불필요한 타입 단언 제거, LINE 플러그인에서 `!` non-null assertion 제거.

### Positive
- LINE 채널의 `lineData.quickReplies!` → `quickReplies` 변수로 추출하여 non-null assertion 3건 제거. 타입 안정성 향상.
- Google Chat의 `as GoogleChatAccountConfig | undefined` 제거 — 타입이 이미 추론 가능하므로 올바른 정리.

### Issues
없음. 깔끔한 정리 커밋.

---

## 3. `0a5821a` — fix(security): enforce strict environment variable validation in exec tool

**Severity:** Critical (security hardening)
**Rating:** Good

### Summary
호스트(gateway/node) 실행 시 위험한 환경변수(`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `PATH` 등)를 차단하는 `validateHostEnv()` 함수 추가.

### Positive
- **Fail-Closed 설계:** 알려진 위험 변수를 차단하고, `PATH` 재정의도 차단하여 바이너리 하이재킹 방지.
- 샌드박스 실행은 제한 없이 통과 — 컨테이너 격리에 의존하는 정상적인 판단.
- 검증을 env 병합 **이전**에 수행하여 위험 변수가 실행 환경에 유입되는 것을 원천 차단.
- 테스트가 기존 "PATH 통과" 테스트를 "PATH 거부" 테스트로 올바르게 변경.

### Issues

**[Medium] `ENV` 변수 차단 범위가 넓을 수 있음**
`ENV`는 `sh`의 초기화 스크립트를 가리키는 변수이지만, 일부 애플리케이션이 `ENV`라는 이름을 일반 설정용으로 사용하는 경우가 있음. 차단이 의도적이지만 false positive 가능성 존재. 에러 메시지에 "이 변수가 필요하면 sandbox 모드를 사용하세요" 같은 안내를 추가하면 UX 개선 가능.

**[Low] case-insensitive 비교 시 원본 키 보존**
에러 메시지에 `${key}` (원본)를 사용하는 것은 좋지만, `DANGEROUS_HOST_ENV_VARS` Set은 대문자만 포함. `env.PATH`는 차단되지만 `env.path`는 별도 로직(`upperKey === "PATH"`)으로 잡음. 일관성은 있으나 Set 검사와 PATH 검사 순서가 분리되어 있어 약간의 혼란 가능.

---

## 4. `a87a07e` — fix: harden host exec env validation (#4896)

**Severity:** Critical (security hardening, #4896 continuation)
**Rating:** Good

### Summary
`LD_*`/`DYLD_*` 접두사 기반 차단을 추가하여, 개별 변수 목록에 없더라도 동적 링커 관련 변수를 일괄 차단.

### Positive
- **접두사 기반 차단**이 개별 변수 목록보다 포괄적 — `LD_DEBUG`, `LD_BIND_NOW`, `DYLD_PRINT_LIBRARIES` 등 모든 변형 차단.
- 접두사 검사를 개별 변수 검사 **앞에** 배치 — 더 넓은 범위가 먼저 평가되는 논리적 순서.
- 문서(`docs/tools/exec.md`)와 changelog 업데이트 포함.

### Issues

**[Low] `DANGEROUS_HOST_ENV_VARS`에 이미 `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`이 있음**
접두사 검사가 이들을 이미 잡으므로 Set에서 제거해도 동작은 동일. 다만 방어적 중복이므로 유해하지는 않음.

**[Low] 접두사 배열이 수정 가능**
`DANGEROUS_HOST_ENV_PREFIXES`를 `as const`로 선언하면 런타임 변조를 방지할 수 있음 (현실적 위험은 낮음).

---

## 5. `b796f6e` — Security: harden web tools and file parsing (#4058)

**Severity:** Critical (prompt injection 방어)
**Rating:** Good — 가장 규모가 크고 중요한 커밋

### Summary
웹 도구(fetch/search) 결과와 파일 파싱 결과를 `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` 마커로 감싸서 LLM이 외부 콘텐츠를 시스템 명령으로 해석하는 것을 방지.

### Positive

**외부 콘텐츠 보안 래핑 (`external-content.ts`)**
- `wrapWebContent()` / `wrapExternalContent()` 함수로 모든 외부 콘텐츠에 보안 경계 적용.
- **호모글리프 마커 우회 방지:** fullwidth 유니코드 문자(`\uFF1C` 등)를 ASCII로 정규화한 후 마커 검출. 공격자가 fullwidth `<<<EXTERNAL_UNTRUSTED_CONTENT>>>`를 삽입하여 경계를 깨려는 시도 차단.
- 마커 새니타이징이 `replaceMarkers()` 내에서 원본 콘텐츠의 위치를 정확히 추적하며 치환 — 올바른 구현.

**웹 도구 래핑 (`web-fetch.ts`, `web-search.ts`)**
- `text`, `title`, `warning`, `description` 등 사용자에게 노출되는 필드를 래핑.
- `url`, `finalUrl`, `contentType` 등 프로토콜 메타데이터는 래핑하지 않음 — 도구 체이닝에 필요하므로 올바른 판단.
- `wrapWebFetchContent()` 함수가 래핑 오버헤드를 고려하여 `maxChars` 제한을 정확히 준수.
- 에러 응답에도 래핑 적용 — 에러 메시지를 통한 injection 경로 차단.

**파일 파싱 강화 (`apply.ts`)**
- `escapeFileBlockContent()`: `<file>` / `</file>` 태그를 엔티티로 이스케이프하여 XML 구조 주입 방지.
- `sanitizeMimeType()`: MIME 타입을 정규식으로 검증하여 비정상 값 차단.
- `resolveUtf16Charset()`: 짝수/홀수 바이트 분석으로 LE/BE 판별 개선.
- `looksLikeUtf8Text()`: `TextDecoder("utf-8", { fatal: true })`를 사용한 엄격한 UTF-8 검증 + CP1252 fallback.
- 오디오 첨부파일이 이미 전사(transcription)된 경우 파일 블록에서 중복 제외 — `skipAttachmentIndexes` 파라미터 추가.
- `allowedMimesConfigured` 플래그: 사용자가 명시적으로 MIME 목록을 설정한 경우 자동 확장을 비활성화.

### Issues

**[Medium] `replaceMarkers()`의 빠른 경로 우회 가능성**
`replaceMarkers()`는 folded 텍스트에서 `external_untrusted_content`를 먼저 검색하고, 없으면 빠르게 반환. 하지만 검색은 folded 텍스트 전체에서 하고 실제 치환은 `<<<` 패턴만 대상으로 함. 만약 공격자가 마커를 `<<<` 없이 삽입하면(예: 다른 구분자 사용) 빠른 경로는 통과하지만 치환은 안 됨. 현재 마커 형식이 `<<<...>>>`로 고정이므로 실질적 위험은 낮지만, 빠른 경로의 검색 범위와 치환 범위가 동일한지 확인이 필요.

**[Medium] `wrapWebFetchContent()` 이중 truncation 로직 복잡도**
래핑 오버헤드 계산 → inner 크기 산출 → truncate → 래핑 → 초과 시 재조정 — 이 로직이 정확하지만 복잡함. 래핑 후 최종 길이가 `maxChars`를 1-2자 초과하는 edge case가 발생할 수 있음. 테스트에서 `<=` 검증이 있으므로 현재는 안전하지만 fuzz 테스트 추가를 권장.

**[Medium] Brave 검색 결과의 `siteName`이 래핑되지 않음**
`web-search.ts`에서 `title`과 `description`은 `wrapWebContent()`로 래핑하지만, `siteName`은 `resolveSiteName(url)`의 결과를 그대로 사용. `siteName`은 URL에서 파싱되므로 외부 콘텐츠 주입 위험은 낮지만, 일관성 측면에서 검토 필요.

**[Low] CP1252 매핑 테이블의 `undefined` 엔트리**
`CP1252_MAP` 배열에서 일부 인덱스가 `undefined`인 경우 `String.fromCharCode(byte)`로 fallback. 이 바이트들은(0x81, 0x8D, 0x8F, 0x90, 0x9D) Windows-1252에서 미정의 코드포인트이므로 `\uFFFD` (replacement character)가 더 안전할 수 있음.

**[Low] `normalizeContentType()` 위치**
`web-fetch.ts` 내부에 정의되어 있지만 다른 모듈에서도 유용할 수 있는 유틸리티 함수. 필요시 공유 모듈로 추출 고려.

---

## Overall Assessment

| Category | Rating |
|---|---|
| 보안 효과 | **Strong** — CWE-400, env injection, prompt injection 대응 |
| 코드 품질 | **Good** — 명확한 관심사 분리, 적절한 주석 |
| 테스트 커버리지 | **Good** — 주요 경로 테스트 포함, edge case fuzz 추가 권장 |
| 하위 호환성 | **Good** — 래핑은 LLM에만 영향, API 필드 구조 변경(rawLength/wrappedLength 추가)은 additive |
| 문서화 | **Good** — exec.md 업데이트, CHANGELOG 포함 |

**총평:** 5개 커밋 모두 보안 강화에 초점을 맞추고 있으며, 방어적 프로그래밍 원칙을 잘 따르고 있음. 특히 `b796f6e`의 외부 콘텐츠 래핑은 prompt injection 방어의 핵심 레이어로서 설계가 견고함. 위에서 지적한 Medium 이슈들은 현재 테스트로 커버되고 있으나, 장기적으로 개선하면 좋을 항목들.
