This PR adds Korean (ko-KR) language support to the Gateway Dashboard, addressing #28212.

### Problem

The Gateway Dashboard currently supports English, Chinese (zh-CN, zh-TW), and Portuguese (pt-BR), but does not include Korean. Korean-speaking users have requested native language support for managing their OpenClaw gateway.

### Changes

- Add `ko-KR.ts` locale file with complete Korean translations
- Update `types.ts` to include `'ko-KR'` in the Locale type
- Update `translate.ts` to:
  - Include `'ko-KR'` in SUPPORTED_LOCALES
  - Add browser language detection for Korean (`navigator.language.startsWith('ko')`)
  - Add dynamic import for lazy-loading Korean translations
- Add `koKR` entry to the languages section in all existing locale files (en, zh-CN, zh-TW, pt-BR)

### Testing

Built and tested locally on macOS 15.3 (M2 MacBook Air) with Node.js v22.12.0:

```bash
cd ui && pnpm install && pnpm build
# TypeScript compilation passes without errors
```

Verified that:

- Korean option appears in the Language dropdown
- Selecting Korean updates UI text correctly
- Browser auto-detection works for ko-KR locale

### Impact

- Low-risk additive change with no breaking changes
- Improves accessibility for Korean-speaking users
- Follows existing i18n patterns in the codebase

Fixes #28212
