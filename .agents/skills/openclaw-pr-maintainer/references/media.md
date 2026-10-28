# GitHub proof media

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
