# RunPR Outreach Pipeline

Weekly automated cold-pitch pipeline for [RunPR](https://runpr.ai/). Sources mid-size US B2B tech PR agencies, fingerprints their incumbent tool stack (Muck Rack / Cision / Meltwater), drafts personalized cold emails in Jeff's voice via codex (gpt-5.5), drops them in `jeff@hypelab.digital`'s Gmail drafts, and pings Jeff over iMessage with the run summary.

## Layout

```
agents/runpr-outreach/
  src/
    index.ts            orchestrator (entry point)
    source-prospects.ts Exa search across query pool, dedupes against tracker
    detect-tools.ts     vendor case-study + wire footer + on-site fingerprint
    find-recent-news.ts pulls the personalization hook
    find-contact.ts     scrapes leadership pages, guesses email pattern
    draft-email.ts      codex CLI wrapper (gpt-5.5 via ChatGPT OAuth)
    push-to-gmail.ts    gog gmail drafts create wrapper
    track-contacted.ts  reads/writes data/contacted-prospects.json
    notify-summary.ts   imsg send wrapper for the post-run ping
    exa-client.ts       fetch wrapper for Exa REST
    types.ts
  data/
    playbook.md                 voice rules (LLM input)
    email-templates.md          reference variants per detected tool
    contacted-prospects.json    dedupe tracker, seeded with 24 day-1 agencies
  cron/
    install.sh          idempotent crontab installer
  package.json, tsconfig.json, .env.example
```

## Setup (forge)

```bash
cd ~/code/openclaw/agents/runpr-outreach
cp .env.example .env
# Set EXA_API_KEY (lift from ~/code/runpr/.env, same key)
npm install
npm run build
```

## Manual run

```bash
# Dry run: full pipeline, no Gmail draft, no tracker write, no imsg.
npm run weekly:dry

# Real run.
npm run weekly
```

## Cron install

```bash
bash cron/install.sh
crontab -l   # verify
```

Schedule: `0 13 * * 1` (Monday 13:00 UTC). That's 9 AM EDT in summer, 8 AM EST in winter. Acceptable per spec.

## Dependencies (forge)

- `node` >= 20 at `/opt/homebrew/bin/node`
- `codex` (codex-cli >= 0.124, authenticated via ChatGPT OAuth running gpt-5.5)
- `gog` (gogcli, authenticated for `jeff@hypelab.digital`)
- `imsg` (>=0.4)
- `EXA_API_KEY` env var

## Output per run

- 10 new Gmail drafts in jeff@hypelab.digital
- `data/contacted-prospects.json` updated with the 10 new entries
- iMessage to Jeff at the configured `NOTIFY_PHONE` summarizing each draft
- Stdout log to `/tmp/runpr-outreach.log`

## Voice + safety rules

See `data/playbook.md`. Highlights:

- No em dashes anywhere (defense-in-depth: post-process strip).
- Never reference team demographics.
- Sentence case subject lines.
- Drafts only. Nothing auto-sends.
- Dedupes on domain AND name to avoid double-pitching.

## Known limitations

- Exa-based contact extraction is heuristic. LOW-confidence contacts get flagged in the imsg summary so Jeff can verify before sending.
- The Gmail integration uses the existing `gog` CLI auth. If that auth lapses, drafts will fail and the pipeline reports the error in the imsg summary.
- This is a best-effort sourcing pipeline. Some Exa results will be agency directories, not actual agencies. Filtering happens at multiple layers.
