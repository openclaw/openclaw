# Obsidian Community Plugin Release

Obsidian Community Plugin Marketplace에 플러그인을 등록하는 end-to-end 프로세스.
PR #10404에서 9번 자동검증 실패 경험으로 만든 스킬. **한 번에 통과**가 목표.

## Prerequisites

- GitHub CLI (`gh`) 인증 완료
- 플러그인 빌드 완료 (`main.js`, `manifest.json`, `styles.css`)
- 레포가 public

## Process (6 Steps)

### Step 1: 레포 구조 검증

레포 **루트**에 다음 파일이 반드시 존재해야 함:

```
/manifest.json    ← 서브폴더 아님, 반드시 루트!
/LICENSE          ← OSI 승인 라이선스 (MIT, Apache-2.0 등)
/README.md        ← 설치/사용법 포함
```

**manifest.json 필수 필드:**

```json
{
  "id": "plugin-id",
  "name": "Plugin Name",
  "version": "X.Y.Z",
  "minAppVersion": "1.0.0",
  "description": "설명 (Obsidian 단어 금지!)",
  "author": "github-username",
  "authorUrl": "https://github.com/username",
  "isDesktopOnly": false
}
```

**자동 검증 스크립트:**

```powershell
$repoRoot = "C:\path\to\repo"

# 1. manifest.json 루트 존재 + 파싱
$manifest = Get-Content "$repoRoot\manifest.json" -Raw | ConvertFrom-Json
Write-Host "✅ manifest.json parsed: id=$($manifest.id), version=$($manifest.version)"

# 2. description에 "Obsidian" 없는지
if ($manifest.description -match "Obsidian") {
  Write-Host "❌ description에 'Obsidian' 포함됨 — 제거 필요!"
} else {
  Write-Host "✅ description OK (no 'Obsidian')"
}

# 3. LICENSE 존재
if (Test-Path "$repoRoot\LICENSE") { Write-Host "✅ LICENSE exists" }
else { Write-Host "❌ LICENSE 없음!" }

# 4. README.md 존재
if (Test-Path "$repoRoot\README.md") { Write-Host "✅ README.md exists" }
else { Write-Host "❌ README.md 없음!" }
```

### Step 2: GitHub Release 생성

**⚠️ Release 이름 = manifest.json version 정확히 (v 접두사 금지!)**

```powershell
$version = $manifest.version  # e.g. "0.1.0"

# Release 생성 — 개별 파일 첨부 (source zip 아님!)
gh release create $version `
  main.js manifest.json styles.css `
  --title $version `
  --notes "Release $version" `
  --repo owner/repo
```

- `main.js`, `manifest.json`, `styles.css`는 **개별 파일**로 첨부
- Release 이름 = `0.1.0` (NOT `v0.1.0`)
- manifest.json의 version과 정확히 일치해야 함

### Step 3: obsidian-releases 레포 Fork + 수정

```powershell
# Fork (이미 있으면 스킵)
gh repo fork obsidianmd/obsidian-releases --clone=false

# Clone fork
gh repo clone <username>/obsidian-releases -- --depth 1
cd obsidian-releases
```

**⚠️ community-plugins.json은 반드시 Python json 모듈로 편집!**

텍스트 에디터/쉘로 직접 편집하면 `\uXXXX` 유니코드 이스케이프가 깨져서 수백 줄 diff가 발생한다.

```python
# add_plugin.py — 이 스크립트를 사용할 것
import json

with open('community-plugins.json', 'r', encoding='utf-8') as f:
    plugins = json.load(f)

ids = [p['id'] for p in plugins]
if 'PLUGIN_ID' in ids:
    print('Already exists!')
else:
    plugins.append({
        "id": "PLUGIN_ID",
        "name": "Plugin Name",
        "author": "github-username",
        "description": "manifest.json과 동일한 description",
        "repo": "owner/repo"
    })
    # ensure_ascii=True 필수! 원본이 \uXXXX 이스케이프 사용
    # newline='\n' 필수! 원본이 LF
    with open('community-plugins.json', 'w', encoding='utf-8', newline='\n') as f:
        json.dump(plugins, f, indent=2, ensure_ascii=True)
        f.write('\n')
    print(f'Added! New count: {len(plugins)}')
```

**편집 후 검증 (필수!):**

```powershell
# 1. JSON 유효성
python -c "import json; json.load(open('community-plugins.json','r',encoding='utf-8')); print('JSON valid')"

# 2. diff 최소화 확인 — 엔트리 추가분(~8줄)만 변경되어야 함
git diff --stat
```

### Step 4: PR 생성 (Template 정확히 준수)

**⚠️ PR body를 공식 template 형식 그대로 사용. 봇이 body를 파싱함!**

PR body 템플릿 (그대로 복사해서 체크박스만 체크):

```markdown
# I am submitting a new Community Plugin

- [x] I attest that I have done my best to deliver a high-quality plugin...

## Repo URL

Link to my plugin: https://github.com/owner/repo

## Release Checklist

- [x] I have tested the plugin on
  - [x] Windows
  - [ ] macOS
  - [ ] Linux
  - [ ] Android _(if applicable)_
  - [ ] iOS _(if applicable)_
- [x] My GitHub release contains all required files...
  - [x] `main.js`
  - [x] `manifest.json`
  - [x] `styles.css` _(optional)_
- [x] GitHub release name matches the exact version number...
- [x] The `id` in my `manifest.json` matches the `id` in the `community-plugins.json` file.
- [x] My README.md describes the plugin's purpose...
- [x] I have read the developer policies...
- [x] I have read the tips in plugin guidelines...
- [x] I have added a license in the LICENSE file.
- [x] My project respects and is compatible with the original license...
```

```powershell
# Commit + Push
git add community-plugins.json
git commit -m "Add plugin: Plugin Name"
git push origin master

# PR 생성
gh pr create `
  --repo obsidianmd/obsidian-releases `
  --title "Add plugin: Plugin Name" `
  --body-file pr-body.md
```

### Step 5: 자동검증 봇 결과 확인

PR 생성 후 수 분 이내에 `github-actions` 봇이 코멘트를 남김.

```powershell
# 최신 봇 코멘트 확인
gh pr view <PR_NUMBER> -R obsidianmd/obsidian-releases --json comments --jq '.comments[-1].body'
```

**통과 시:** 에러 없음 → 리뷰 대기
**실패 시:** 에러 메시지 확인 → 수정 → push → 봇 재검증 (재검증마다 코멘트 누적되므로 최소화!)

### Step 6: 리뷰 대기 & 대응

- Obsidian 팀이 코드 리뷰 (수일~수주 소요)
- 리뷰 코멘트 시 신속 대응
- 변경 요청 시 수정 → push → re-request review

## Common Pitfalls (PR #10404 경험)

| 실수                            | 결과                                      | 방지법                       |
| ------------------------------- | ----------------------------------------- | ---------------------------- |
| manifest.json 서브폴더에만 존재 | "manifest.json not found"                 | 반드시 루트에 배치           |
| LICENSE 누락                    | "does not include a license"              | 루트에 LICENSE 파일          |
| description에 "Obsidian"        | "don't include Obsidian"                  | "for your vault" 등으로 대체 |
| PR/manifest description 불일치  | "Description mismatch"                    | 한 곳에서 확정 → 복사        |
| PR template 미준수              | "did not follow PR template"              | 공식 template 그대로 사용    |
| JSON trailing comma             | "invalid JSON"                            | jq / ConvertFrom-Json 검증   |
| 텍스트 에디터로 JSON 편집       | `\uXXXX` → `?` 유니코드 깨짐, 수백줄 diff | Python json 모듈로만 편집    |
| `git diff --stat` 미확인        | 불필요한 변경 포함된 채 PR                | diff가 ~8줄인지 반드시 확인  |
| Release 이름 `v0.1.0`           | 이름 불일치                               | `0.1.0` (v 없이)             |

## Lessons Learned

자세한 내용: `memory/obsidian-marketplace-lessons.md`

### 실전 결과

- **PR #10404**: 사전 검증 없이 제출 → 9회 자동검증 실패 → 닫음
- **PR #10406**: 이 스킬 절차대로 진행 → **1회 통과** (plugin-validation SUCCESS, 코멘트 0)
- **핵심**: community-plugins.json은 Python json 모듈로만 편집 + git diff 최소화 확인

## References

- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Developer policies](https://docs.obsidian.md/Developer+policies)
- [PR template](https://raw.githubusercontent.com/obsidianmd/obsidian-releases/refs/heads/master/.github/PULL_REQUEST_TEMPLATE/plugin.md)
