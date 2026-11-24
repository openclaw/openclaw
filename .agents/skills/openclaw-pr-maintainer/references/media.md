# GitHub proof media

## PR visual proof

Make the problem and the change understandable without reading the diff. This
standard covers visual changes to the web UI, macOS, iOS, and Android apps. It is
for PR evidence, not App Store or Google Play screenshots, release assets, or
routine diagnostic captures. Leave those capture/upload pipelines and their
output directories unchanged.

1. **Choose the comparison.** The implementing agent chooses the affected user
   flow, representative state, annotation targets, short labels, and a readable
   annotation palette suited to the captured image and theme. Do not ask
   the user to mark screenshots or supply coordinates. Cover affected platforms
   and materially different states, not an automatic four-platform matrix.
2. **Capture the product.** Use the existing platform workflow: [Control UI
   E2E](../../control-ui-e2e/SKILL.md), [iOS E2E](../../ios-e2e/SKILL.md), or the
   actual macOS/Android app on a device or emulator. Use current main for before
   and the change for after; identify both revisions. Match viewport/window,
   theme, data, interaction state, crop, and scale. Fixtures may supply data to
   the real app; disclose them and emulation. A recreated screen or DOM edit is
   not implementation proof. Capture during focused verification rather than
   running the same flow again just for media.
3. **Explain on copies.** Preserve the clean frames. Generate separate annotated
   copies from those same frames using [measured annotations](../../proof-video/references/annotations.md).
   Mark the specific defect before and the resulting behavior after. Annotations
   explain the evidence; they do not replace behavior assertions or prove backend
   effects. Keep PR artifacts separate from store/release assets.
4. **Inspect and present.** Check both versions at full size and intended PR
   display size. The clean pair shows the actual UI; the annotated pair explains
   the change. Follow the layout below and the [delivery gate](#screenshot-completion-gate).

### Comparison layout

Keep both pairs visible in the PR: **clean before/after first, annotated
before/after second**. Never hide either pair in a disclosure or behind a gallery
link. Use two columns when text remains readable. For wide captures, stack
Before then After within each pair instead of shrinking them to fit. Keep enough
surrounding UI to understand the state.

Example for a narrow/mobile comparison; replace the four URL placeholders with
uploaded images and write alt text describing the actual observation:

```markdown
### Clean comparison

| Before                                           | After                                         |
| ------------------------------------------------ | --------------------------------------------- |
| ![Before: account shown twice](BEFORE_CLEAN_URL) | ![After: account shown once](AFTER_CLEAN_URL) |

### Annotated comparison

| Before                                                | After                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| ![Repeated account highlighted](BEFORE_ANNOTATED_URL) | ![Single account and source highlighted](AFTER_ANNOTATED_URL) |
```

Add one short caption naming the scenario, before/after revisions, and any
fixture or emulator limitation. Add another comparison only for a materially
different effect. Videos and larger galleries are optional supplements, not
extra work required by this standard.

The annotated-only presentation in [#199217](https://github.com/openclaw/openclaw/pull/199217)
illustrates why explanation and clean inspection should both remain available.

## Upload and delivery

- Read only for authorized, inspected, sanitized capture publication.
- Captions, narration cues, zooms, fast-forward idle time: [proof-video dev skill](../../proof-video/SKILL.md) first. Mocked Control UI/native captures + cue sidecar supported; raw proof preserved, burned-in MP4 output. Attach inspected polished MP4; never commit generated media.
- PR/issue uploads: feature-detect repeatable `--attach` on `gh issue create`, `gh issue edit`, `gh issue comment`, matching `gh pr` commands. Example: `gh pr comment <pr> --repo openclaw/openclaw --body-file <comment.md> --attach <proof.mp4>`.
- `gh --attach` videos: `.mp4`, `.mov`, `.webm`; local max 100 MB, GitHub account limit may be lower. No `#alt` on video path. Bare URL renders player; uploads permanent.
- Missing `--attach` → `curl -s "https://uploads.github.com/user-attachments/assets?name=<file>&content_type=<mime>&repository_id=$(gh api repos/<owner>/<repo> --jq .id)" -X POST -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/json" --data-binary @<file>`. Embed returned `.url`: image `![alt](url)`, video bare line. 422 = unsupported type; 404 = bad repo id/no push. `content_type`: `video/mp4`, `video/quicktime`, `video/webm`. `![]()` ≠ player. Playwright webm → `ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p out.mp4`. Both routes: drag-drop CDN, repo visibility, no browser/computer use. Non-media: Crabbox artifact publishing + manifest URL.
- Failed upload never waives [screenshot completion gate](#screenshot-completion-gate). Approved artifact-store fallback counts only as chat image attachments + inline PR images, not manifest URL. Successful chat delivery needs no browser-render check/user confirmation. Verify PR rendering; otherwise explicit delivery blocker, no merge/completion unless user waives destination.

- Never browser upload, product-branch media commits, unrelated `gh attach` extension. Uploads inherit repo visibility. No private desktop content, identifiers, model routes, secrets.
- Unsupported artifacts/endpoint failure → approved artifact store only; never invent destination. Feature-detect format/size support, never assume CLI release.

## Screenshot completion gate

- Visual appearance/rendered UI change: inspected, sanitized before/after screenshots in originating chat AND upload/embed in PR body or body-linked comment.
- Successful chat attachment delivery satisfies chat gate. No user's-browser rendering check, visibility question, or block for inability to inspect chat.
- Verify PR images render before merge/completion. Local files/private inspection/chat-only/logs/tests/review approval/artifact-manifest links insufficient. Galleries/videos supplement, never replace screenshots.
- Known attachment/upload failure = delivery blocker; repair or report. Only explicit user waiver exempts destination.
