# MAI Deploy Skill

MAI Universe 프로젝트 배포 자동화 가이드.

---

## A. 웹 서비스 — Railway

**대상:** MAIOSS, MAIBEAUTY, MAISTAR7

```powershell
cd C:\TEST\MAI{프로젝트}

# 초기 설정 (최초 1회)
railway login
railway init
railway link

# 환경변수 설정
railway variables set DATABASE_URL="..." API_KEY="..."

# 배포
railway up

# 상태 확인
railway status
railway logs
```

### 배포 전 체크리스트

- [ ] `pnpm build` 성공
- [ ] `pnpm test` 통과
- [ ] 환경변수 설정 완료 (`deploy.json`의 `env_required` 참조)
- [ ] `railway.json` 또는 `Procfile` 존재

### 롤백

```powershell
railway rollback
```

---

## B. 모바일 앱 — EAS Build (Expo)

**대상:** MAIBOTALKS, MAITUTOR

```powershell
cd C:\TEST\MAI{프로젝트}

# 초기 설정 (최초 1회)
npx eas-cli login
npx eas-cli init

# 빌드
npx eas-cli build --platform all

# 스토어 제출
npx eas-cli submit --platform ios
npx eas-cli submit --platform android

# OTA 업데이트 (코드만 변경 시)
npx eas-cli update --branch production
```

### 배포 전 체크리스트

- [ ] `app.json` 버전 번호 증가
- [ ] `eas.json` 프로필 설정 확인
- [ ] 스토어 인증서/키 설정 완료
- [ ] `npx expo doctor` 통과

---

## C. OpenClaw 스킬 — clawhub

**대상:** Mnemo 스킬, 각 봇 스킬

```powershell
# 스킬 퍼블리시
clawhub publish skills/{스킬명}

# 검증
clawhub list
```

### 배포 전 체크리스트

- [ ] `SKILL.md` 작성 완료
- [ ] 스킬 디렉토리 구조 정상

---

## D. 오픈소스 — GitHub + npm/pip

**대상:** MAIOSS

```powershell
cd C:\TEST\MAIOSS

# 버전 범프
npm version patch  # or minor / major

# GitHub Release
gh release create v1.0.0 --generate-notes

# npm 퍼블리시
npm publish --access public

# pip (Python 패키지인 경우)
python -m build
twine upload dist/*
```

### 배포 전 체크리스트

- [ ] README.md 업데이트
- [ ] LICENSE 파일 존재
- [ ] CHANGELOG.md 업데이트
- [ ] CI/CD (GitHub Actions) 통과
- [ ] `.npmignore` 또는 `files` 필드 설정

---

## E. 정적 사이트 — GitHub Pages / Vercel

**대상:** MAIOSS docs, MAICON docs

```powershell
# GitHub Pages
cd C:\TEST\MAI{프로젝트}
pnpm build:docs
gh-pages -d docs/.vitepress/dist

# Vercel
vercel --prod
```

### 배포 전 체크리스트

- [ ] 문서 빌드 성공
- [ ] 링크 깨짐 없음
- [ ] `vercel.json` 또는 GitHub Pages 설정 완료

---

## 배포 점검

```powershell
# 전체 프로젝트 배포 상태 점검
powershell C:\MAIBOT\scripts\deploy-check.ps1
```
