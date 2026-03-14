Generate a weekly edition of "The AI Signal" newsletter — signal vs noise for technology and business leaders.

$ARGUMENTS

## Purpose

Sync new subscribers from Gmail → Notion, research this week's top AI stories weighted by subscriber interests, draft the full newsletter with clickable source links, save the archive copy, and create a Gmail draft ready to review and send to ssdash7.newsletters@gmail.com.

## Parameters (from $ARGUMENTS)

- `--issue <n>` — override issue number (default: auto-detect from archive count)
- `--date <YYYY-MM-DD>` — override issue date (default: today)
- `--dry-run` — skip Gmail draft creation, just save and print
- `--skip-sync` — skip Gmail subscriber sync step

## Subscriber Interest Categories (from narwal.one subscription form)

- Artificial Intelligence
- Digital Transformation
- Data Analytics
- Supply Chain Optimization
- Customer Experience
- Sales & Marketing Technology
- Cloud Computing
- Cybersecurity

## Story → Interest Tag Mapping

When tagging each story, map to one or more of the above categories:

- AI models, agents, LLMs → Artificial Intelligence
- Enterprise AI adoption, org change, strategy → Digital Transformation
- Data platforms, analytics tools, BI → Data Analytics
- Logistics, inventory, procurement AI → Supply Chain Optimization
- CX tools, personalization, chatbots → Customer Experience
- Martech, sales AI, revenue tools → Sales & Marketing Technology
- Cloud infrastructure, GPU, compute → Cloud Computing
- Security AI, compliance, regulation → Cybersecurity

---

## Process

### Step 0 — Sync subscribers from Gmail (skip if --skip-sync)

Search Gmail for new subscription notification emails from narwal.one in the last 7 days:

```
gmail_search_messages query="from:narwal.one OR subject:\"New Subscriber\" OR subject:\"newsletter subscription\" newer_than:7d" max=20
```

For each result:

1. Read the email body to extract: Full Name, Email, Position/Title, Industry, Areas of Interest (checkboxes selected)
2. Search Notion DB `9094f55e-ccda-44c4-b862-8d41be4b8461` for existing entry with matching email
3. If NOT found: create a new page in Notion with all extracted fields + Status=Active + today's Subscribed Date
4. If found: skip (already synced)

After sync, print: `Subscribers synced: [N] new added`

If no subscription emails found, print: `No new subscribers this week` and continue.

---

### Step 1 — Read subscriber interest distribution

Query all Active subscribers from Notion data source `9094f55e-ccda-44c4-b862-8d41be4b8461`.

Count frequency of each interest tag across all active subscribers. Example output:

```
Artificial Intelligence: 24 subscribers
Digital Transformation: 18 subscribers
Cybersecurity: 15 subscribers
Data Analytics: 12 subscribers
Cloud Computing: 10 subscribers
Customer Experience: 8 subscribers
Sales & Marketing Technology: 6 subscribers
Supply Chain Optimization: 4 subscribers
```

Store as ranked interest list. Use the **top 4 interests** to bias story selection in Step 2.

If no subscribers yet (first run), use default weights: AI > Digital Transformation > Data Analytics > Cybersecurity.

---

### Step 2 — Research (run 3 web searches in parallel)

Search for this week's top AI stories across three angles:

1. `"top AI news [current date / this week] 2026"` — general top stories
2. `"AI enterprise tools announcements [this week] 2026"` — enterprise/B2B angle
3. `"AI model releases research breakthroughs [this week] 2026"` — technical/model angle

For each story shortlisted, **capture the best source URL** (the original article, not a news aggregator) — this is required for Step 5.

Shortlist the **6 best stories** using this priority order:

1. Highest real-world business/leadership impact
2. Stories matching top 4 subscriber interests (from Step 1) — bias selection here
3. Most surprising or counterintuitive development
4. Enterprise tool or workflow relevance
5. Regulatory or policy movement
6. Model capability leap

Drop consumer novelty stories unless they have clear enterprise implications.

For each of the 6 selected stories, produce:

```
story_slug: [kebab-case slug]
headline_draft: [working headline]
source_url: [best original source URL — required]
interest_tags: [list from the 8 categories above]
summary: [2-3 sentence summary of the story]
```

---

### Step 3 — Determine issue number

Count `.md` files in `outputs/content/newsletters/` (excluding `.gitkeep`).
Issue number = count + 1. Override with `--issue` if provided.

---

### Step 4 — Draft the newsletter

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

**[Story 1 Headline]** [Source: [Domain Name]([source_url])]

[Para 1: What happened — 2 sentences, plain English, specific numbers/names]

[Para 2: Why it matters — 1-2 sentences connecting to leadership/enterprise impact]

[Para 3: The implication — 1 sentence, forward-looking or provocative]

> **Practitioner Take:** [One bold, specific, actionable sentence. Tell them exactly what to do or watch.]

*Tags: [comma-separated interest tags]*

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

---

### Step 5 — Quality gate

Before saving, verify:

- [ ] Lead headline would make someone open the email
- [ ] Every story has a specific number, name, or fact (no vague claims)
- [ ] Every Practitioner Take is actionable (starts with a verb or tells them what to do)
- [ ] No paragraph exceeds 3 sentences
- [ ] No buzzwords: revolutionary, game-changing, groundbreaking, unprecedented, paradigm shift
- [ ] Subheadline accurately reflects the 5 remaining stories
- [ ] Every story has a valid source_url captured
- [ ] Interest tags assigned to all 6 stories

---

### Step 6 — Save archive copy

Save to: `outputs/content/newsletters/ai-signal-[YYYY-MM-DD].md`

```
---
issue: [N]
date: [YYYY-MM-DD]
headline: [lead headline text]
stories: [comma-separated story slugs]
subscriber_count: [N active subscribers]
top_interests: [top 4 interest tags]
---

[full newsletter text with tags]
```

---

### Step 7 — Create Gmail draft (skip if --dry-run)

Use `gmail_create_draft` with:

- **To:** ssdash7.newsletters@gmail.com
- **Subject:** `The AI Signal #[N]: [Lead Headline]`
- **Body:** HTML formatted with the template below

**HTML template rules:**

- Story `<h3>` must be a clickable link to the source URL: `<h3><a href="[source_url]" style="color:#0d0d0d;text-decoration:none;">[Story Headline]</a></h3>`
- Add a "Read more →" link at the bottom of each story block: `<p class="readmore"><a href="[source_url]">Read more →</a></p>`
- Interest tags shown as small pill badges below each Practitioner Take box

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
      .story h3 a {
        color: #0d0d0d;
        text-decoration: none;
      }
      .story h3 a:hover {
        text-decoration: underline;
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
      .readmore {
        margin-top: 10px;
        font-size: 13px;
      }
      .readmore a {
        color: #0d0d0d;
        font-family: "Helvetica Neue", Arial, sans-serif;
        font-weight: 600;
      }
      .tags {
        margin-top: 8px;
      }
      .tag {
        display: inline-block;
        background: #f0f0ec;
        border-radius: 3px;
        padding: 2px 7px;
        font-size: 11px;
        color: #666;
        font-family: "Helvetica Neue", Arial, sans-serif;
        margin-right: 4px;
      }
      .footer {
        padding: 24px 36px;
        background: #f9f9f7;
        border-top: 1px solid #e8e8e4;
      }
      .footer p {
        font-size: 13px;
        color: #888;
        font-family: "Helvetica Neue", Arial, sans-serif;
        margin: 0 0 6px;
      }
      .subscriber-note {
        font-size: 11px;
        color: #aaa;
        font-family: "Helvetica Neue", Arial, sans-serif;
        margin-top: 12px;
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="header">
        <h1>THE AI SIGNAL</h1>
        <p>Separating signal from noise that matters for leadership</p>
      </div>
      <div class="issue-line">
        Issue #[N] &nbsp;·&nbsp; [Day, Month DD, YYYY] &nbsp;·&nbsp; [N] subscribers
      </div>
      <div class="lead">
        <h2>[Lead Headline]</h2>
        <p class="sub">[Subheadline / story teasers]</p>
      </div>
      <hr class="divider" />

      <!-- Story block — repeat for each of 6 stories -->
      <div class="story">
        <h3><a href="[source_url]">[Story Headline]</a></h3>
        <p>[Para 1]</p>
        <p>[Para 2]</p>
        <p>[Para 3]</p>
        <div class="practitioner">
          <p><strong>Practitioner Take:</strong> [Actionable sentence]</p>
        </div>
        <p class="readmore"><a href="[source_url]">Read more →</a></p>
        <div class="tags">
          <span class="tag">[Interest Tag 1]</span>
          <span class="tag">[Interest Tag 2]</span>
        </div>
      </div>
      <!-- End story block -->

      <div class="footer">
        <p>That's the signal this week. If one of these changes how you're thinking, hit reply.</p>
        <p>— The AI Signal</p>
        <p class="subscriber-note">
          You're receiving this because you subscribed at
          <a href="https://narwal.one" style="color:#aaa;">narwal.one</a>. To unsubscribe, reply
          with "unsubscribe".
        </p>
      </div>
    </div>
  </body>
</html>
```

Populate all placeholders with actual content. Every story headline must be a live `<a href>` link.

---

### Step 8 — Confirm and report

```
✓ The AI Signal #[N] — [Date]
  Headline: [lead headline]
  Stories: 6 stories drafted
  Sources: all 6 stories have clickable links ✓
  Active subscribers: [N]
  Top interests this issue: [top 4]
  New subscribers synced: [N]
  Archive: outputs/content/newsletters/ai-signal-[YYYY-MM-DD].md
  Gmail draft: [created / skipped (--dry-run)]
  To: ssdash7.newsletters@gmail.com
  Subject: The AI Signal #[N]: [Lead Headline]
  Notion DB: https://www.notion.so/86e5e24d7f5b4dc6a5f586fd1188ddab
```
