---
name: seo-audit
description: SEO audit framework for Enth's blog and digital presence targeting beauty nail brands.
metadata: { "openclaw": { "emoji": "🔍" } }
---

# SEO Audit

## Enth Context

- **Company:** Enth — 대한민국 1위 네일 제조회사
- **Target Audience:** B2B 뷰티 네일 브랜드사 (OEM/ODM 파트너십 대상)
- **Channels:** Blog (Ghost CMS at beautykorea.me.kr) + LinkedIn
- **Market:** 한국 뷰티 산업, 글로벌 네일 시장
- **Tone:** 전문적, 파트너십 지향, 제조 역량 중심
- **Key Messages:** 제조 기술 우위, OEM/ODM 역량, 네일 제품 혁신
- **Enth SEO Priority Keywords:** 네일 OEM, 네일 ODM, 네일 제조, nail manufacturer Korea, nail color OEM, beauty brand partnership, 뷰티 브랜드 제조사
- **Enth CMS:** Ghost — audit for canonical tags, sitemap.xml auto-generation, and structured data support
- **Bilingual strategy:** Korean primary + English secondary; apply hreflang for dual-language posts

## SEO Audit Framework

Perform audits in this priority order: crawlability → technical → on-page → content quality → authority.

### 1. Crawlability & Indexation

- Verify `robots.txt` allows crawling of all key pages (blog posts, product pages, partnership landing pages)
- Check `sitemap.xml` exists and is submitted to Google Search Console
- Identify orphaned pages with no internal links
- Audit redirect chains (avoid 301 → 301 → 301)
- Check for `noindex` tags on pages that should be indexed
- Ghost CMS: confirm sitemap auto-generation is enabled and up to date

### 2. Technical Foundations

- **Site speed:** Core Web Vitals (LCP < 2.5s, FID < 100ms, CLS < 0.1) — use PageSpeed Insights
- **Mobile-friendliness:** Test on multiple screen sizes; Ghost themes are usually responsive
- **HTTPS:** Verify SSL certificate is valid and no mixed content warnings
- **Structured data:** Check for Article, Organization, BreadcrumbList schema on blog posts
- **Note:** `web_fetch`/`curl` cannot detect JS-injected schema — use Google's Rich Results Test for verification

### 3. On-Page SEO

For each key page, audit:

| Element          | Best Practice                                 |
| ---------------- | --------------------------------------------- |
| Title tag        | 50–60 chars; primary keyword near front       |
| Meta description | 150–160 chars; includes CTA and keyword       |
| H1               | One per page; matches search intent           |
| H2/H3            | Logical hierarchy; include secondary keywords |
| Image alt text   | Descriptive; includes keyword where natural   |
| URL slug         | Short, keyword-rich, lowercase, hyphens       |
| Internal links   | 3–5 per post to related content               |
| Canonical tag    | Self-referencing on all pages                 |

### 4. International SEO (Enth-specific)

- Implement `hreflang` for Korean/English dual-language blog posts
- Use `x-default` hreflang for the default (Korean) version
- Ensure canonicalization is consistent across language versions
- Locale URL structure: `/ko/` prefix or subdirectory for Korean content

### 5. Content Quality (E-E-A-T)

For Enth's B2B audience, E-E-A-T signals matter:

- **Experience:** Include case studies and real production numbers
- **Expertise:** Author bios with manufacturing credentials
- **Authoritativeness:** Industry certifications, awards, "1위 제조사" claims with citations
- **Trustworthiness:** Company address, contact info, privacy policy, partner logos

Content depth checklist:

- [ ] Posts > 1,500 words for pillar topics
- [ ] Includes original data, product specs, or manufacturing insights
- [ ] External links to authoritative beauty industry sources
- [ ] Updated dates visible; evergreen content refreshed annually

### 6. Common Issues by Site Type

**Blog/Content Site (Ghost CMS):**

- Duplicate content from tag/author archive pages → add `noindex` to archive pages
- Pagination issues → use `rel="next"` and `rel="prev"` or canonical to page 1
- Thin content on tag pages → consolidate or add descriptive intros

**B2B Lead Gen Site:**

- Landing pages blocked by `robots.txt` → verify
- Form pages indexed → consider `noindex` for thank-you pages
- No structured data on homepage → add Organization schema

### 7. Audit Report Structure

When reporting findings, use this structure:

```
## SEO Audit Report — [Site/Page]

### Critical Issues (fix immediately)
- [Issue]: [Impact] — [Fix]

### High Priority (fix this sprint)
- [Issue]: [Impact] — [Fix]

### Opportunities (backlog)
- [Opportunity]: [Estimated impact]

### Quick Wins
- [Action]: [Expected result]
```
