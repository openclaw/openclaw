# Obsidian Community Plugin Marketplace 등록 — Lessons Learned

_PR #10404 (Mnemo SecondBrain) 경험 기반. 2026-02-21_

## 타임라인

### PR #10404 (실패 → 닫음)

| 시도  | 에러                                                                                   | 원인                                                                                                |
| ----- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1차   | PR template 미준수 + description에 "Obsidian" 포함 + manifest.json 없음 + LICENSE 없음 | 초기 제출 시 사전 체크 없이 진행                                                                    |
| 2~5차 | PR template 미준수 + manifest.json 없음 + LICENSE 없음                                 | manifest.json이 `obsidian-plugin/` 서브폴더에만 있었고, 레포 루트에 없었음. LICENSE도 루트에 없었음 |
| 6차   | PR template 미준수 + description 불일치                                                | PR의 community-plugins.json description과 repo manifest.json의 description이 달랐음                 |
| 7차   | PR template 미준수 + manifest.json 파싱 실패                                           | 루트에 manifest.json 추가했지만 파싱 에러 (인코딩 또는 형식 문제)                                   |
| 8차   | PR template 미준수                                                                     | PR body가 template 형식을 정확히 따르지 않음                                                        |
| 9차   | community-plugins.json 파싱 에러                                                       | **텍스트 에디터로 편집 → 유니코드 이스케이프(`\uXXXX`)가 `?`로 깨짐 → 225줄 변경**                  |

**근본 원인**: community-plugins.json을 텍스트 에디터/쉘로 직접 편집하면 `ensure_ascii=True`로 된 `\uXXXX` 이스케이프가 깨진다.

### PR #10406 (재제출 → ✅ 한 번에 통과)

- Python `json.load()` → append → `json.dump(ensure_ascii=True)` 사용
- diff: **8줄만 변경** (엔트리 추가만, 기존 내용 무변경)
- `plugin-validation` check: **SUCCESS** (코멘트 0개 = 에러 없음)
- 리뷰 대기 중

## 핵심 실수 & 교훈

### 1. manifest.json은 반드시 **레포 루트**에 있어야 함

- ❌ `obsidian-plugin/manifest.json` → 자동검증 봇이 찾지 못함
- ✅ 레포 루트 `/manifest.json` 필수
- 서브폴더 구조 레포는 루트에 복사하거나, 플러그인 전용 레포 사용 고려

### 2. LICENSE 파일은 **레포 루트**에 있어야 함

- 자동검증 봇이 루트의 LICENSE 존재를 체크
- MIT, Apache-2.0 등 OSI 승인 라이선스 필요

### 3. description에 "Obsidian" 단어 금지

- Obsidian 마켓플레이스 정책: 플러그인 설명에 "Obsidian" 포함 불가
- "for your vault" 등으로 대체

### 4. description은 PR과 manifest.json이 **완전 동일**해야 함

- `community-plugins.json`의 description ≠ repo `manifest.json`의 description → 에러
- 한 곳에서 먼저 확정 → 그대로 복사

### 5. PR template을 **정확히** 따라야 함

- `obsidianmd/obsidian-releases`는 자동검증 봇이 PR body를 파싱
- 공식 template: `.github/PULL_REQUEST_TEMPLATE/plugin.md`
- 제목, 체크박스, 섹션 순서 모두 그대로 유지
- 체크박스 `- [x]` 형식 정확히

### 6. community-plugins.json은 **반드시 Python json 모듈로 편집**

- ❌ 텍스트 에디터/쉘로 직접 편집 → `\uXXXX` 유니코드 이스케이프가 깨짐 (225줄 diff 발생)
- ✅ `json.load()` → 수정 → `json.dump(ensure_ascii=True, indent=2)` → 최소 diff
- 편집 후 반드시 `json.load()`로 유효성 검증
- 원본 줄바꿈이 LF이므로 `newline='\n'` 명시

### 7. GitHub Release 이름은 버전 번호 **정확히 일치** (v 접두사 없음)

- manifest.json `"version": "0.1.0"` → Release 이름 `0.1.0` (NOT `v0.1.0`)
- Release에 `main.js`, `manifest.json`, `styles.css` 개별 파일 첨부 (source zip 아님)

### 8. 한 번에 성공하는 것이 중요

- 수정 후 다시 push → 봇이 재검증 → 에러 코멘트 누적
- 9개 에러 코멘트는 리뷰어에게 나쁜 인상
- **제출 전 로컬에서 전수 검증 후 한 번에 통과하는 것이 목표**

## 사전 검증 체크리스트 (제출 전 필수)

```
□ 레포 루트에 manifest.json 존재 + JSON 파싱 성공
□ 레포 루트에 LICENSE 존재 (OSI 승인 라이선스)
□ manifest.json description에 "Obsidian" 단어 없음
□ community-plugins.json을 Python json 모듈로 편집 (텍스트 에디터 금지!)
□ community-plugins.json의 description == manifest.json의 description (글자 하나까지 동일)
□ git diff --stat → 변경 최소화 확인 (엔트리 추가분만)
□ GitHub Release 생성됨 (이름 = version 정확히, v 접두사 없음)
□ Release에 main.js, manifest.json, styles.css 개별 첨부
□ PR body가 공식 template 형식 정확히 준수 (복사 후 체크박스만 체크)
□ README.md에 설치/사용법 명시
□ eval() 미사용, 불필요한 네트워크 요청 없음
```

## 참고 링크

- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Developer policies](https://docs.obsidian.md/Developer+policies)
- [PR template](https://raw.githubusercontent.com/obsidianmd/obsidian-releases/refs/heads/master/.github/PULL_REQUEST_TEMPLATE/plugin.md)
- 실패 PR: https://github.com/obsidianmd/obsidian-releases/pull/10404 (닫음, 9회 실패)
- 성공 PR: https://github.com/obsidianmd/obsidian-releases/pull/10406 (1회 통과)

---

_Created: 2026-02-21_
