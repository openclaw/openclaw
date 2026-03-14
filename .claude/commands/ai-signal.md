Generate a weekly edition of "The AI Signal" newsletter — signal vs noise for technology and business leaders.

$ARGUMENTS

## Purpose

Research this week's top AI stories, draft the full newsletter in The AI Signal format, save the archive copy, and create a Gmail draft ready to review and send to ssdash7.newsletters@gmail.com.

## Parameters (from $ARGUMENTS)

- `--issue <n>` — override issue number (default: auto-detect from archive count)
- `--date <YYYY-MM-DD>` — override issue date (default: today)
- `--dry-run` — skip Gmail draft creation, just save and print

## Process

### Step 1 — Research (run 3 web searches in parallel)

Search for this week's top AI stories across three angles:

1. `"AI news [this week / current date]"` — general top stories
2. `"AI enterprise tools announcements [this week]"` — enterprise/B2B angle
3. `"AI model releases research breakthroughs [this week]"` — technical/model angle

Collect all results. De-duplicate. Shortlist the **6 best stories** by this priority order:

1. Highest real-world business/leadership impact
2. Most surprising or counterintuitive development
3. Enterprise tool or workflow relevance
4. Regulatory or policy movement
5. Model capability leap

Drop consumer novelty stories unless they have clear enterprise implications.

### Step 2 — Determine issue number

Count `.md` files in `outputs/content/newsletters/` (excluding `.gitkeep`).
Issue number = count + 1. Override with `--issue` if provided.

### Step 3 — Draft the newsletter

Read `memory/brand/writing_style.md` before drafting. Apply the voice throughout: clear, direct, executive, practitioner-not-theorist. Short paragraphs. Specifics over vague claims.

Use this exact structure:

```
---
THE AI SIGNAL
Separating signal from noise that matters for leadership.
Issue #[N] | [Day, Month DD, YYYY]
---

[LEAD HEADLINE — written like a tweet, not a press release. Lead with the most surprising/impactful story. Use an active verb. Max 10 words.]

[SUBHEADLINE — one line teasing the other 5 stories, comma-separated, ending with "...and more"]

---

**[Story 1 Headline — action-oriented, no jargon]**

[Para 1: What happened — 2 sentences, plain English, specific numbers/names]

[Para 2: Why it matters — 1-2 sentences connecting to leadership/enterprise impact]

[Para 3: The implication — 1 sentence, forward-looking or provocative]

> **Practitioner Take:** [One bold, specific, actionable sentence. Tell them exactly what to do or watch.]

---

[Repeat for stories 2–6]

---

That's the signal this week. If one of these changes how you're thinking, hit reply.

— The AI Signal
```

Story headline rules:

- No "X announces Y" — use the outcome instead ("X makes Y obsolete")
- No buzzwords (revolutionary, game-changing, groundbreaking)
- Must be readable without context

Per-story word count: 120–180 words + Practitioner Take (1 sentence).
Total target: 900–1,200 words.

### Step 4 — Quality gate

Before saving, verify:

- [ ] Lead headline would make someone open the email
- [ ] Every story has a specific number, name, or fact (no vague claims)
- [ ] Every Practitioner Take is actionable (starts with a verb or tells them what to do)
- [ ] No paragraph exceeds 3 sentences
- [ ] No buzzwords: revolutionary, game-changing, groundbreaking, unprecedented, paradigm shift
- [ ] Subheadline accurately reflects the 5 remaining stories

### Step 5 — Save archive copy

Save to: `outputs/content/newsletters/ai-signal-[YYYY-MM-DD].md`

File format:

```
---
issue: [N]
date: [YYYY-MM-DD]
headline: [lead headline text]
stories: [comma-separated story slugs]
---

[full newsletter text]
```

Create the `outputs/content/newsletters/` directory if it doesn't exist.

### Step 6 — Create Gmail draft (skip if --dry-run)

Use `gmail_create_draft` to create a draft with:

- **To:** ssdash7.newsletters@gmail.com
- **Subject:** `The AI Signal #[N]: [Lead Headline]`
- **Body:** HTML-formatted newsletter using the template below

HTML email template:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        font-family: Georgia, "Times New Roman", serif;
        background: #f9f9f7;
        margin: 0;
        padding: 0;
      }
      .wrapper {
        max-width: 620px;
        margin: 32px auto;
        background: #ffffff;
        border: 1px solid #e8e8e4;
      }
      .header {
        background: #0d0d0d;
        padding: 28px 36px;
      }
      .header h1 {
        color: #ffffff;
        font-size: 22px;
        font-weight: 700;
        margin: 0;
        letter-spacing: 2px;
        font-family: "Helvetica Neue", Arial, sans-serif;
      }
      .header p {
        color: #999999;
        font-size: 12px;
        margin: 6px 0 0;
        letter-spacing: 1px;
        font-family: "Helvetica Neue", Arial, sans-serif;
        text-transform: uppercase;
      }
      .issue-line {
        background: #f0f0ec;
        padding: 10px 36px;
        font-size: 12px;
        color: #666;
        font-family: "Helvetica Neue", Arial, sans-serif;
        border-bottom: 1px solid #e0e0da;
      }
      .lead {
        padding: 28px 36px 8px;
      }
      .lead h2 {
        font-size: 26px;
        line-height: 1.3;
        color: #0d0d0d;
        margin: 0 0 8px;
      }
      .lead p.sub {
        font-size: 14px;
        color: #666;
        font-family: "Helvetica Neue", Arial, sans-serif;
        margin: 0;
      }
      .divider {
        border: none;
        border-top: 2px solid #0d0d0d;
        margin: 20px 36px;
      }
      .story {
        padding: 20px 36px;
        border-bottom: 1px solid #f0f0ec;
      }
      .story h3 {
        font-size: 17px;
        font-weight: 700;
        color: #0d0d0d;
        margin: 0 0 12px;
        line-height: 1.4;
      }
      .story p {
        font-size: 15px;
        line-height: 1.7;
        color: #333;
        margin: 0 0 10px;
      }
      .practitioner {
        background: #f5f5f0;
        border-left: 3px solid #0d0d0d;
        padding: 10px 14px;
        margin-top: 14px;
      }
      .practitioner p {
        font-size: 13px;
        color: #0d0d0d;
        margin: 0;
        font-family: "Helvetica Neue", Arial, sans-serif;
      }
      .practitioner strong {
        font-weight: 700;
      }
      .footer {
        padding: 24px 36px;
        background: #f9f9f7;
      }
      .footer p {
        font-size: 13px;
        color: #888;
        font-family: "Helvetica Neue", Arial, sans-serif;
        margin: 0 0 6px;
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="header">
        <h1>THE AI SIGNAL</h1>
        <p>Separating signal from noise that matters for leadership</p>
      </div>
      <div class="issue-line">Issue #[N] &nbsp;·&nbsp; [Day, Month DD, YYYY]</div>
      <div class="lead">
        <h2>[Lead Headline]</h2>
        <p class="sub">[Subheadline / story teasers]</p>
      </div>
      <hr class="divider" />
      <!-- Repeat this block for each story -->
      <div class="story">
        <h3>[Story Headline]</h3>
        <p>[Para 1]</p>
        <p>[Para 2]</p>
        <p>[Para 3]</p>
        <div class="practitioner">
          <p><strong>Practitioner Take:</strong> [Actionable sentence]</p>
        </div>
      </div>
      <!-- End story block -->
      <div class="footer">
        <p>That's the signal this week. If one of these changes how you're thinking, hit reply.</p>
        <p>— The AI Signal</p>
      </div>
    </div>
  </body>
</html>
```

Populate the HTML template with actual newsletter content before creating the draft.

### Step 7 — Confirm and report

Print a confirmation block:

```
✓ The AI Signal #[N] — [Date]
  Headline: [lead headline]
  Stories: [N] stories drafted
  Archive: outputs/content/newsletters/ai-signal-[YYYY-MM-DD].md
  Gmail draft: [created / skipped (--dry-run)]
  To: ssdash7.newsletters@gmail.com
  Subject: The AI Signal #[N]: [Lead Headline]
```
