---
name: expo-appstore-deploy
description: Deploy Expo/React Native apps to Apple App Store and Google Play Store using EAS Build + Submit. Use when building iOS/Android production builds, submitting to app stores, managing certificates/provisioning profiles, or troubleshooting EAS build failures. Triggers on "앱스토어 배포", "App Store 제출", "EAS build", "production build", "앱 배포", "스토어 제출".
---

# Expo App Store Deploy

## Prerequisites Check

Before starting, verify:

1. Apple Developer Program active (check `https://developer.apple.com/account`)
2. Google Play Console account + identity verification complete
3. `eas-cli` installed: `npx eas-cli --version`
4. EAS project linked: `eas.json` exists with `projectId` in `app.config.ts`

## iOS Deploy Pipeline

### First-Time Setup (Interactive Required)

```bash
# Must run interactive for Apple login + certificate generation
npx eas-cli build --platform ios --profile production
# → Apple ID + password + 2FA (prefer SMS if device auth fails)
# → Auto-generates Distribution Certificate + Provisioning Profile
```

### Subsequent Builds (Non-Interactive OK)

```bash
npx eas-cli build --platform ios --profile production --non-interactive
```

### Submit to App Store Connect

```bash
# After build succeeds
npx eas-cli submit --platform ios --id <BUILD_ID>

# Or build + submit in one command
npx eas-cli build --platform ios --profile production --auto-submit
```

## Critical Config

### app.config.ts — Must Include

```typescript
ios: {
  infoPlist: {
    ITSAppUsesNonExemptEncryption: false,  // Skips export compliance prompt
    // Add all permission descriptions
  },
}
```

### eas.json — Production Profile

```json
{
  "build": {
    "production": {
      "autoIncrement": true,
      "node": "22.17.1",
      "env": { "EAS_BUILD_NO_EXPO_GO_WARNING": "true" },
      "ios": { "image": "latest" },
      "android": { "buildType": "app-bundle" }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleTeamId": "<TEAM_ID>",
        "ascAppId": "<ASC_APP_ID>"
      }
    }
  }
}
```

## App Store Connect Status Reference

| 상태           | 의미                       | 다음 액션                   |
| -------------- | -------------------------- | --------------------------- |
| 제출 준비 중   | IPA 업로드+Processing 완료 | 메타데이터 입력 → 심사 제출 |
| 심사 대기 중   | 심사 큐에 진입             | 대기 (1-7일)                |
| 심사 중        | Apple 심사 진행            | 대기                        |
| 판매 준비 완료 | 승인됨                     | 출시!                       |
| 거부됨         | 심사 탈락                  | 사유 확인 → 수정 → 재제출   |

## Browser Access Notes

- **App Store Connect / Google Play Console**: `profile=chrome` 필수 (기존 로그인 세션 필요)
- `profile=openclaw`은 별도 프로필이라 인증 사이트 접근 불가
- 외출 중 상태 확인: 아이폰 **App Store Connect 앱** 활용
- Chrome 탭 연결: OpenClaw 확장 아이콘 클릭 → badge ON

## Known Failure Patterns

### "Install dependencies" Build Failure

**Cause:** Native binary packages (sharp, canvas, bcrypt, node-gyp deps) in devDependencies.
**Fix:** Remove from devDependencies — EAS installs all deps including dev.

```bash
npm uninstall <package> --save-dev
```

### "Credentials are not set up" (non-interactive)

**Cause:** First build requires interactive Apple login for certificate generation.
**Fix:** Run first build without `--non-interactive`. After certs are stored on EAS, non-interactive works.

### Apple 2FA "Invalid code"

**Cause:** Device auth code is single-use and expires in ~30 seconds.
**Fix:** Switch to `sms` method. Don't reuse codes.

### "ascAppId is not allowed to be empty"

**Cause:** Empty string in eas.json submit config.
**Fix:** Remove `ascAppId` field entirely for first submit (auto-creates app), then add the returned ID.

### "You've already submitted this build"

**Not an error** — previous submission succeeded. Check App Store Connect status.
If new build needed, `autoIncrement: true` handles version bump automatically.

## Android Deploy Pipeline

### Build

```bash
npx eas-cli build --platform android --profile production --non-interactive
```

### Submit

```bash
npx eas-cli submit --platform android --id <BUILD_ID>
```

Requires: Google Play Console identity verification complete + service account JSON key.

## Post-Submit Checklist

1. App Store Connect → Processing complete (10-30 min)
2. TestFlight test (optional but recommended)
3. Add metadata: screenshots, description, keywords, categories
4. Set pricing (paid/free)
5. Provide review demo credentials in Review Notes
6. Submit for review (1-7 days typical)

## App Store Review Tips

- AI apps: Apple may require 12+ or 17+ age rating
- Microphone permission: clear description required in NSMicrophoneUsageDescription
- External server dependency: must handle offline/disconnected state gracefully
- If social login exists: Apple Sign In is mandatory
- "Restore Purchases" button required for paid apps
- Privacy labels must be accurate
- Demo account/URL for reviewers is critical for apps needing server connection

## 🔥 Pre-Submit URL Checklist (CRITICAL)

**제출 전에 반드시 모든 URL이 실제로 접근 가능한지 확인!**

Apple 심사관이 확인하는 URL:

1. **Privacy Policy URL** — 앱 정보 페이지
2. **Support URL** — 앱 버전 페이지
3. **Marketing URL** — 앱 정보 + 버전 페이지
4. **Review Notes 내 URL** — 심사 메모에 기재한 모든 링크
5. **앱 설명(Description) 내 URL** — 텍스트에 포함된 링크

```bash
# 제출 전 URL 검증 스크립트
$urls = @(
  "https://your-domain.com/privacy",
  "https://your-domain.com/terms",
  "https://your-domain.com/support"
)
foreach ($url in $urls) {
  $r = Invoke-WebRequest -Uri $url -Method HEAD -UseBasicParsing
  Write-Host "$($r.StatusCode) $url"
}
# 모두 200이어야 함!
```

### 도메인 미준비 시 — GitHub Pages Interim 전략

커스텀 도메인 구매 전이라면 GitHub Pages를 임시 호스팅으로 활용:

```bash
# 1. 정적 사이트 repo 생성
gh repo create <user>/<app>-web --public
# 2. HTML/CSS 페이지 작성 (privacy, terms, support)
# 3. GitHub Pages 활성화 (Settings → Pages → Deploy from branch)
# 4. URL 패턴: https://<user>.github.io/<app>-web/privacy/
```

**주의:**

- GitHub Pages URL은 `/repo-name/` prefix 포함 → 내부 링크에 base path 적용 필요
- 심사 통과 후 커스텀 도메인 구매 → CNAME 설정 → ASC URL 갱신

### 서버 의존 앱의 심사 전략

사용자 자체 서버가 필요한 앱 (SSH 클라이언트, VPN, Gateway 클라이언트 등):

- **온보딩에 "건너뛰기(Skip)" 버튼** 필수 — 리뷰어가 서버 없이 UI 확인 가능
- Review Notes에 건너뛰기 방법 상세 기술
- "SSH/VPN 클라이언트와 유사한 구조"라고 명시하면 리뷰어 이해에 도움

### Review Notes 작성 팁

```
필수 포함:
1. 앱이 뭐하는지 한 줄 설명
2. 테스트 방법 (step-by-step, 건너뛰기 포함)
3. 서버 의존성 설명 (왜 데모 계정이 없는지)
4. 주요 화면 목록 (리뷰어가 확인할 수 있는 것)
5. Privacy Policy / Terms / Support URL

언어: 영어 (리뷰어가 한국어 이해 못할 수 있음)
한국어 UI 요소는 괄호로 영어 병기: "건너뛰기" (Skip)
```

## ASC (App Store Connect) 수정 시 주의사항

### 심사 중 수정

- "심사 대기 중" 상태에서는 직접 수정 가능 (심사 취소 불필요한 경우도 있음)
- "심사 중" 상태라면 먼저 심사 취소 → 수정 → 재제출

### 브라우저 자동화 한계 (profile=chrome)

- ASC textarea에 긴 텍스트 입력 시 `slowly: true`도 20초 타임아웃 가능
- JS `evaluate`로 직접 값 설정 시 React state와 불일치 가능
- **권장:** ASC 메타데이터 수정은 수동으로 하거나, 짧은 텍스트만 자동화
- 대안: `eas metadata:push` (EAS Metadata) 사용 시 CLI로 일괄 수정 가능

### EAS Metadata (store.config.json)

```bash
# App Store 메타데이터를 코드로 관리
npx eas-cli metadata:pull  # ASC에서 현재 메타데이터 다운로드
# store.config.json 수정
npx eas-cli metadata:push  # ASC에 업로드
```

이 방식이 브라우저 자동화보다 안정적 (다음 제출부터 권장)
