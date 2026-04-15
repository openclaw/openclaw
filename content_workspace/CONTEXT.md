# TikTok Content Workflows — Master Overview & Implementation Priority

## Status
- This workspace is currently INITIALIZED.
- Prioritize locking the Notion Jobs database schema and Shared storage.

## Job Routing
- New jobs should be generated inside `jobs_sync/template_job/` and then moved to specific stages in either `1_sharp_daily_essentials/` or `2_currentbrief/`.

---

**Owner:** Jared
**Accounts:** Sharp Daily Essentials (TikTok Shop) + CurrentBrief (TikTok CRP)
**Format:** Faceless AI-generated video content
**Tool stack:** Claude Code, Hypernatural.ai (automated), Kling / Higgsfield / Google Veo (manual scenes), DALL-E 3, Imagen 3, CapCut

---

## How Each Account Earns

| | Sharp Daily Essentials | CurrentBrief |
|---|---|---|
| Program | TikTok Shop Affiliate | TikTok Creator Rewards (CRP) |
| Paid on | Purchases through affiliate link | Qualified For You feed views |
| Rate | 5–20%+ per sale (varies by product) | ~$0.40–$1.50+ per 1,000 qualified views |
| Optimize for | Click-through and purchase intent | Completion rate, watch time, engagement |
| Min. video length | No minimum | 60 seconds (required for CRP eligibility) |
| Affiliate links | Yes — one product per video | Never — CRP only |
| AI disclosure | Toggle ON | Toggle ON |

---

# WORKSPACE 1: Sharp Daily Essentials
**TikTok Shop Affiliate**

## Content Production Pipeline (5 Stages)
### Stage 1: Product Research
- **Input:** Product name, URL, or affiliate link
- **Process:** Research product, summarize benefits, identify target audience, surface TikTok-specific angles
- **Output:** `product_research.md`

### Stage 2: Script Writing
- **Input:** `product_research.md` + voice/tone config
- **Process:** Write a 120–150 word TikTok script — hook, benefit scenes, CTA
- **Output:** `script_draft.md`

### Stage 3: Image Prompts
- **Input:** `script_draft.md` + avatar guidelines config
- **Process:** Write AI image generation prompts per scene — AI avatar using/wearing/holding the product
- **Output:** `image_prompts.md`

### Stage 4: Production Notes
- **Input:** `script_draft.md` + `image_prompts.md`
- **Process:** Assembly notes for CapCut or Hypernatural.ai — scene order, timing, transitions, captions, audio, export checklist
- **Output:** `production_notes.md`

### Stage 5: Hypernatural API Prompt
- **Input:** `script_draft.md` + `production_notes.md`
- **Process:** Compose a screenplay-style prompt for the Hypernatural API + recommended parameters
- **Parameters:** portrait 9:16, 1080p, ~30s intended length, visibility private
- **Output:** `hn_api_prompt.md` (human review) + `hn_payload.json` (machine-readable)
- **Submit:** `bash shared/hn_submit.sh stages/05_hn-api-prompt/output/hn_payload.json`

## Upload Workflow (Manual Today)
### Pre-Upload Requirement
Products must be added to Creator Affiliate Showcase before they can be linked.
Path: TikTok Creator Center → Shop Product Marketplace → Add to Showcase

### Upload Steps
1. Upload video to TikTok
2. Caption: 2–3 sentences leading with product benefit (not product name)
3. Hashtags: 3–5 niche-specific tags — no mega-tags like #fyp or #viral
4. SEO terms: product category, use case, problem it solves (separate line)
5. Toggle "AI Generated" → ON
6. Add Link → Product → search Creator Affiliate Showcase
7. Confirm product match → Post

### Caption Block Template
[2–3 sentences on the product benefit. Lead with why it matters, not what it is.]

#[product-category] #[use-case] #[niche-audience] #[problem-solved] #[product-type]

[Product category term] | [Use case] | [Problem it solves] | [Target audience]

### Optimization Notes
- Hook within 3 seconds — show the product solving a problem immediately
- 30–60 seconds is the sweet spot for Shop affiliate videos
- Show the product in use — demonstration drives purchase intent
- Soft CTA only — "link below" or "tap to shop"
- Price anchoring works — mention price if competitive ("under $X")

---

# WORKSPACE 2: CurrentBrief
**TikTok Creator Rewards Program**

## Content Production Pipeline (4 Stages)
### Stage 1: Script Package (primary output — most content generated here)
- **Input:** Topic, news headline, or idea
- **Process:** Verify all facts against credible news sources. Write a full Script Package including: Hook, Script, Scene Breakdown, Call to Action, Video Prompts, Image Prompts, Cap/Comment Blocks.
- **Output:** `script_draft.md`

### Stage 2: Supplementary Image Prompts (optional)
- **When to use:** Only when additional stills are needed beyond what Stage 1 covers
- **Input:** `script_draft.md` + specific scenes/subjects flagged by Jared
- **Process:** Write additional DALL-E 3 + Imagen 3 JSON prompt pairs per scene
- **Output:** `image_prompts.md`

### Stage 3: Production Notes
- **Input:** `script_draft.md` + `image_prompts.md`
- **Process:** Assembly notes for Hypernatural.ai — scene order, timing, transitions, pacing to hit 60s minimum
- **Output:** `production_notes.md`

### Stage 4: Hypernatural API Prompt
- **Input:** `script_draft.md` + `production_notes.md`
- **Output:** `hn_api_prompt.md` + `hn_payload.json`
- **Submit:** `bash shared/hn_submit.sh stages/04_hn-api-prompt/output/hn_payload.json`

## Upload Workflow (Manual Today)
### Caption Block Template
[2–3 sentence description. Primary keyword in first 150 characters.]

#news #breakingnews #newsupdate #[video-specific-1] #[video-specific-2]

Breaking political news | [Video-specific term 1] | [Video-specific term 2] | Current events USA

### Optimization Notes
- Hook within 3 seconds — determines whether viewers stay
- Target 70%+ completion rate — biggest driver of CRP payouts
- 60–90 seconds is the sweet spot for CRP
- Every sentence must earn its place — do not pad to hit length
- Say primary keyword aloud in narration AND display as on-screen text — TikTok indexes both

---

# SHARED AUTOMATION SYSTEM
**Applies to both workspaces**

## Architecture: Two-Agent Model
### NanoClaw — Control Plane (Primary Laptop)
- Reads product/idea queue from Notion
- Makes or surfaces approval decisions
- Creates job packets and writes them to Notion
- Monitors job status, handles escalation
- Writes final artifacts back to Notion
- Never executes heavy generation tasks directly

### OpenClaw — Execution Plane (Secondary Laptop)
- Polls Notion for jobs in "Assigned" status assigned to openclaw
- Executes the assigned pipeline stage
- Writes output artifacts to shared storage (OneDrive or Git)
- Updates job status: Running → Returned or Failed
- Triggers Tier 1 quality checks before marking complete
- Never approves its own output — routes back through Nano

## Quality Gates
### Tier 1 — Automated Hard Checks (OpenClaw, no human needed)
- Script length within target duration
- JSON validity for Hypernatural payload
- All required job packet fields populated
- No cross-account contamination 
- Video QA: resolution, audio, duration bounds
- On failure: auto-retry once with modified instruction → escalate to "Needs Review" in Notion if retry fails

### Tier 2 — Human Spot Checks (flagged async, not blocking)
- Script tone and persuasiveness
- Product image parity for SDE
- First publish of any new product type or topic category
- Any job that triggered an auto-retry

## Notion Jobs Database (To Be Built)
Key fields:
- Job ID
- Account (SDE / CurrentBrief)
- Product name / topic / URL
- Pipeline stage
- Status: Ideas → Approved → Assigned → Running → Returned → Failed → Needs Review → Published
- Assigned worker: nanoclaw / openclaw
- Artifact pointers (shared storage paths)
- QA report summary

## Shared Storage Schema (To Be Locked)
/jobs/{job_id}/input.json
/jobs/{job_id}/output/script.md
/jobs/{job_id}/output/hn_payload.json
/jobs/{job_id}/qa_report.json

## OpenClaw Polling Mechanism (Not Yet Implemented)
- Simple loop on secondary laptop
- Checks Notion every N minutes for jobs in "Assigned" status
- Options: cron job, scheduled Claude Code skill, lightweight script

## Model Selection
- OpenClaw execution tasks: Claude Sonnet 4.6 (reliable structured output, cost-efficient at volume)
- Complex reasoning (ambiguous research, retry logic): Claude Opus 4.6

## Implementation Priority Order
1. Lock Notion Jobs database schema 
2. Define shared storage folder structure
3. Get OpenClaw running on secondary laptop + confirm Notion read/write access
4. Build first working loop: Approved → Script → Tier 1 QA → Returned
5. Add retry logic once base loop is stable
6. Expand quality gates and autonomy from there
