---
name: blog-publish
description: Publish Kendrick's dev-blog/it-blog posts from finalized Markdown plus user-supplied images. Use when asked to publish, preview, convert Markdown to Astro Markdoc .mdoc, attach Telegram/Slack-uploaded images, make webp assets, or prepare a preview deploy. Preserves approved article text, validates schema/assets, pushes preview first, and requires explicit approval for production.
---

# Blog Publish

Kendrick의 `dev-blog` 글을 최종 Markdown 초안에서 Astro Markdoc 포스트로 변환하고, 사용자가 직접 올린 이미지를 webp 에셋으로 정리해 preview 배포까지 진행한다.

## 핵심 원칙

- 기본 repo: `/Users/kendrick/projects/dev-blog`
- 글 파일: `src/content/blog/{lang}/{slug}.mdoc`
- 에셋: `src/assets/{slug}-*.webp`
- 사용자가 준 Markdown 본문은 이미 승인된 최종본으로 취급한다.
- 문장/구조/논지를 임의로 고치지 않는다. 스키마, 경로, Markdoc 빌드 오류만 고친다.
- 사용자가 직접 업로드한 이미지를 우선 사용한다. 임의 AI 이미지는 만들지 않는다.
- 항상 `preview` 브랜치에 먼저 올리고 preview URL을 보고한다.
- `main`/production 배포는 사용자의 명시적 승인 없이는 하지 않는다.

## 시작 전 안전 체크

```bash
cd /Users/kendrick/projects/dev-blog
git fetch origin --prune
git status --short
git branch --show-current
git status -sb
```

- 관련 없는 로컬 변경이 있으면 덮어쓰지 말고 보고한다.
- preview 작업은 최신 `origin/preview` 기준으로 시작한다.
- worktree가 깨끗한 것을 확인한 뒤에만 `git reset --hard origin/preview`를 쓴다.

일반 시작 흐름:

```bash
git fetch origin --prune
git checkout -B preview origin/preview
```

## Markdown 처리

1. 첨부 `.md` 또는 채팅 안의 fenced Markdown을 읽는다.
2. 언어가 명시되지 않았으면 본문으로 `ko`/`en`을 판단한다.
3. 영어 kebab-case slug를 정한다.
4. 기존 파일 충돌 여부를 확인한다: `src/content/blog/{lang}/{slug}.mdoc`.
5. 본문은 보존하고 frontmatter만 live schema에 맞춘다.
6. `.mdoc`로 저장한다.
7. 이미지가 있으면 webp로 변환하고 경로를 갱신한다.
8. `npm run build`로 검증한다.

두 언어 버전은 사용자가 요청했거나 양쪽 파일을 제공한 경우에만 만든다.

## Frontmatter 규칙

작업 전 live schema를 확인한다.

- `src/content/config.ts`
- `src/lib/blogTaxonomy.ts`
- 최근 글: `src/content/blog/{lang}/`
- 템플릿: `src/_templates/`

일반 글 권장 형태:

```yaml
---
draft: false
title: "..."
description: "..."
tldr:
  - "..."
faq:
  - q: "..."
    a: "..."
date: 2026-01-01
cover: ../../../assets/{slug}-cover.webp
coverAlt: "..."
topic: ai
format: article
---
```

규칙:

- `title`은 원문 제목을 따른다.
- `description`, `tldr`, `faq`는 원문에 없는 주장을 추가하지 않는다.
- `date`는 사용자가 준 날짜가 없으면 발행일을 쓴다.
- `cover`는 커버 이미지가 있을 때만 slug 기반 webp를 가리키게 한다.
- `tags`, `type`, `category`, `topics` 같은 구/임의 필드는 넣지 않는다.
- `topic`/`format`은 live enum 안에서만 고른다.

현재 관찰된 topic:

```text
ai, development, productivity, security, career, personal, blog
```

현재 관찰된 format:

```text
article, book-review, retrospective, announcement
```

## 이미지 처리

- 최종 에셋은 모두 `src/assets/`의 `.webp`로 둔다.
- `cwebp`가 있으면 사용한다.
- 글 slug 기준으로 이름을 맞춘다.
- 원본 임시 파일은 커밋하지 않는다.
- 읽을 수 있어야 하는 스크린샷/도표는 과압축하지 않는다.
- 의미를 해치지 않도록 임의 crop은 하지 않는다.

예시:

```bash
cwebp -q 82 input.png -o src/assets/{slug}-cover.webp
cwebp -q 78 input.png -o src/assets/{slug}-01.webp
```

파일명 규칙:

- 커버: `{slug}-cover.webp`
- 본문 이미지: `{slug}-01.webp`, `{slug}-02.webp`, ...
- 이미 존재하는 파일은 확인 없이 덮어쓰지 않는다.

## 이미지 배치

이미지를 맨 위에 몰아넣지 말고 가장 가까운 문맥에 배치한다.

- `썸네일`, `cover`, `대표 이미지`: frontmatter `cover`에만 넣고 본문에는 중복 삽입하지 않는다.
- `본문 이미지`, `예제`, `도표`, `다이어그램`, `스크린샷`: 관련 문단/섹션 바로 아래에 넣는다.
- 사용자가 특정 위치를 지시하면 그 지시가 자동 판단보다 우선이다.
- 의미 있는 alt text를 직접 작성한다.

본문 이미지 문법:

```md
![의미 있는 alt 텍스트](../../../assets/{asset-file}.webp)
```

## 서평/제공 고지

책 리뷰라면 근처 기존 book-review 글의 고지 문구와 위치를 먼저 확인한다.

Hanbit Media / `<나는 리뷰어다>` 제공 리뷰는 기존 관례가 유지되는 경우 H1 바로 아래, TL;DR 위에 둔다.

````md
# Article Title

```
"한빛미디어 <나는 리뷰어다> 활동을 위해서 책을 제공받아 작성된 서평입니다."
```

**TL;DR**
````

사용자가 제공/협찬 사실을 말하지 않았다면 임의로 고지 문구를 추가하지 말고 물어본다.

## Preview 배포

```bash
cd /Users/kendrick/projects/dev-blog
git fetch origin --prune
git checkout -B preview origin/preview

# write/update .mdoc and webp assets
npm run build

git status --short
git add src/content/blog/{lang}/{slug}.mdoc src/assets/{slug}-*.webp
git commit -m "Add {slug} blog post"
git push origin preview
```

Preview URL:

```text
https://it-blog-git-preview-bumfoo-s-team.vercel.app/{lang}/blog/{slug}/
```

## Production 배포

- 사용자가 `발행해`, `main에 올려`, `production 배포해`, `publish it` 등으로 명시 승인한 경우에만 진행한다.
- production 전에 최신 `origin/main` 기준을 확인하고 `npm run build`를 다시 통과시킨다.
- preview에 올린 의도된 변경만 main으로 가져간다.

## 검증 체크리스트

- [ ] 본문 문장/구조/논지를 임의로 rewrite하지 않았다.
- [ ] live schema를 확인했다.
- [ ] unsupported frontmatter 필드가 없다.
- [ ] `topic`과 `format`이 live enum 값이다.
- [ ] 이미지가 slug 기반 `.webp`로 `src/assets/`에 있다.
- [ ] cover/body 이미지 경로가 실제 파일과 맞다.
- [ ] alt text가 의미 있다.
- [ ] 임시 원본 이미지가 커밋되지 않았다.
- [ ] `npm run build`가 통과했다.
- [ ] 관련 `.mdoc`/asset만 staged/committed 했다.
- [ ] `origin/preview`에 push했고 production은 승인 전까지 건드리지 않았다.

## 보고 형식

짧게 결과 중심으로 보고한다.

```text
preview에 올렸어요.

- 글: `src/content/blog/ko/{slug}.mdoc`
- 이미지: `src/assets/{slug}-cover.webp`, `src/assets/{slug}-01.webp`
- 빌드: `npm run build` 통과
- push: `origin/preview`

확인 링크:
https://it-blog-git-preview-bumfoo-s-team.vercel.app/ko/blog/{slug}/

확인해보고 괜찮으면 production 발행하라고 말해줘요.
```
