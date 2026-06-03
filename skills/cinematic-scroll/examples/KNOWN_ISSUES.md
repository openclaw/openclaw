# Known issues (QA log)

## 2026-05-23 — Prompt #1: `npm install` fails with ETARGET on Lenis

**Symptom:** `No matching version found for @studio-freight/lenis@^1.0.45`

**Cause:** Claude regenerated `package.json` from memory instead of copying `templates/nextjs/package.json`. The old `@studio-freight/lenis` scope is deprecated (max 1.0.42). Version `^1.0.45` does not exist.

**Fix in skill v1.1.1:**
- Bundled `templates/nextjs/package.json` with `"lenis": "^1.3.23"`
- SKILL.md forbids `@studio-freight/lenis` and invented versions
- Added `lib/use-lenis.ts` + `SmoothScrollProvider.tsx`

**Patch if Claude still generates wrong deps:** replace with bundled `package.json`, run `npm install` again.

---

## 2026-05-23 — Terminal: pasted README block causes `command not found: #`

**Symptom:** `zsh: command not found: #`, `MODULE_NOT_FOUND` for scripts

**Cause:** User pasted multi-line README instructions including `#` comment lines. zsh runs each line separately; comments become invalid commands.

**Fix:** Run one command at a time:

```bash
npm install
cp .env.example .env.local
npm run dev
```

---

## 2026-05-23 — Claude removed `choreo-3d` and hand-rolled parallax

**Symptom:** Custom `ParallaxChapter.tsx`, inline types instead of `choreo-3d`

**Cause:** Claude ignored bundled `EditionsPage.tsx` which imports `ScrollLayer`, `ScrollChoreography`, etc.

**Fix:** Copy `templates/nextjs/components/EditionsPage.tsx` and ensure `"choreo-3d": "^1.0.0"` in `package.json`.

---

## 2026-05-23 — `next: command not found`

**Symptom:** `npm run dev` → `sh: next: command not found`

**Cause:** `npm install` failed earlier (Lenis ETARGET), so `node_modules` was never created.

**Fix:** Fix `package.json` first, then `npm install`, then `npm run dev`.
