# Static Preview Upgrades — Cinematic Scroll

Use this reference when applying `cinematic-scroll` to existing static preview / outreach pages rather than greenfield product sites.

## Context

For lead-preview pages, the goal is not a maximal cinematic demo. It is a sharper conversion artifact: premium feel, clear trade/service positioning, direct call/quote CTA, and enough motion grammar to feel crafted without making the preview fragile.

## Recommended pattern

1. **Inspect first**
   - Identify the exact existing `index.html` path(s).
   - Confirm title, H1, business identity, suburb, trade/service, and existing contact CTA.
   - Check git status before editing. Do not stage unrelated untracked directories.

2. **Use Mode A unless the repo is already an app**
   - Single self-contained HTML is usually right for GitHub Pages outreach previews.
   - Inline CSS/JS, no npm/build step.
   - Use `requestAnimationFrame` scroll handling, not raw per-event DOM mutation.

3. **Keep the preview constraints**
   - Preserve `noindex, nofollow` on outreach/preview artifacts.
   - Preserve business identity, suburb, service category, and phone CTA.
   - Do not invent metrics, testimonials, accreditations, or completed-project claims.
   - Use proof language based on service process and visible craft, not fabricated outcomes.

4. **Cinematic grammar that fits trade pages**
   - Hero: 5-layer depth field with subtle parallax.
   - Copy sections: chapter cards that read like inspection/process/proof, not SaaS feature blocks.
   - Motion: restrained reveal, transform/opacity only, no gimmick overload.
   - CTA: always reachable on mobile and repeated near the close.

5. **Verification before ship**
   - Static check each changed page for: `viewport-fit=cover`, `prefers-reduced-motion`, `data-depth`, `requestAnimationFrame`, `noindex, nofollow`, `tel:`.
   - Serve locally and verify every route returns HTTP 200.
   - Browser inspect at least one representative page for JS errors, horizontal overflow, depth layers, and first-screen visual quality.
   - If committing, stage only the intended `index.html` files.
   - After push, verify live GitHub Pages URLs, not just local files.

## Pitfalls

- A cinematic pass can accidentally become a generic dark template. Re-anchor each page to the specific trade, suburb, and service promise.
- Existing preview repos often contain unrelated untracked work. `git add .` is wrong unless the user explicitly asked for a whole-repo commit.
- Do not remove `noindex` from previews unless the user explicitly asks to make them public SEO assets.
- Browser typing/tool failures during verification are not a reason to claim deployment. Use the last verified local/live output only.
