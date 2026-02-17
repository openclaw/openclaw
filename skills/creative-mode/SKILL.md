---
name: creative-mode
description: Autonomous creative content generation mode. Use when the user wants creative output like social media posts, blog ideas, marketing copy, brainstorming, storytelling, or when they say "creative mode", "brainstorm", "generate ideas", "content sprint", or "be creative". Also triggers for autonomous content workflows where the agent proposes and creates content independently.
metadata: { "openclaw": { "emoji": "🎨" } }
---

# Creative Mode

Autonomous creative content generation. When activated, generate content proactively and propose ideas.

## Modes

### Brainstorm Mode

Generate ideas without filtering. Quantity over quality first, then refine.

```
Input: "Brainstorm content about AI agents"
Output: 10-20 raw ideas, then rank top 5 by impact and feasibility
```

### Content Sprint Mode

Rapid-fire content creation. Set a target and produce.

```
Input: "Content sprint: 5 social media posts about OpenClaw"
Output: 5 ready-to-post pieces with hashtags and call-to-action
```

### Story Mode

Narrative-driven content. Turn dry topics into engaging stories.

```
Input: "Story mode: How we built our AI agent system"
Output: Narrative blog post with hook, tension, resolution
```

## Content Types

| Type               | Length         | Format                    | Use Case                      |
| ------------------ | -------------- | ------------------------- | ----------------------------- |
| **X/Twitter Post** | 280 chars      | Plain text + hashtags     | Quick announcements, insights |
| **Thread**         | 5-10 posts     | Numbered thread           | Deep dives, tutorials         |
| **Blog Post**      | 800-1500 words | Markdown with frontmatter | SEO, thought leadership       |
| **LinkedIn Post**  | 500-1000 chars | Professional tone         | B2B, networking               |
| **Newsletter**     | 500-800 words  | Sections with headers     | Weekly/monthly updates        |
| **Video Script**   | 60-180 seconds | Script with timing notes  | Reels, TikTok, YouTube Shorts |

## Autonomous Workflow

### When in creative mode, the agent should:

1. **Scan context** - Read recent research digests, workspace notes, and trending topics
2. **Generate ideas** - Produce 5-10 content ideas based on current context
3. **Propose to user** - Present top 3 ideas with:
   - Title/hook
   - Target platform
   - Estimated engagement potential
   - Time to produce
4. **Wait for approval** - Do NOT publish without user confirmation
5. **Create content** - Once approved, produce the full content
6. **Save to workspace** - Store in `~/workspace/content/<type>/<date>-<slug>.md`

### Auto-Proposal Schedule

When combined with cron and research-scout:

```
# Daily content suggestions at 9 AM
cron action:"add" name:"Daily Content Ideas" schedule:"0 9 * * 1-5" tz:"Europe/Berlin" session:"isolated" message:"Review ~/workspace/research/ for recent findings. Generate 3 content proposals based on trending topics. Format each as: Title, Platform, Hook (first line), Why Now. Save proposals to ~/workspace/content/proposals/YYYY-MM-DD.md and announce to me." announce:true channel:"last"
```

## Writing Guidelines

### Hooks (First Line)

- Start with a bold claim, question, or number
- "Most people miss this about AI agents..."
- "I automated my entire blog pipeline in 10 minutes."
- "3 AI tools that changed how I work (all free)"

### Structure

- **Short paragraphs** (1-3 sentences max)
- **Line breaks** between thoughts (especially for social media)
- **Bold key phrases** for scanability
- **End with CTA** (call to action, question, or next step)

### Tone

- Conversational, not corporate
- Show, don't tell (include examples, screenshots, results)
- Be specific (numbers, tool names, time saved)
- Authentic > polished

## Content Templates

### X/Twitter Thread Template

```
1/ [Hook - bold statement or question]

2/ [Context - why this matters now]

3/ [The solution/tool/insight]

4/ [How it works - step by step]

5/ [Results or proof]

6/ [Call to action]

Save this thread. 🔖
```

### Blog Post Template

```markdown
---
title: "[Specific, Benefit-Driven Title]"
date: YYYY-MM-DDT00:00:00Z
tags: ["ai", "agents", "automation"]
---

[Hook paragraph - grab attention in 2 sentences]

## The Problem

[1-2 paragraphs on pain point]

## The Solution

[Main content - tool, technique, or insight]

## How to Get Started

[Step-by-step guide]

## Results

[What changed, metrics, before/after]

---

_[Brief CTA or question to engage readers]_
```

## Integration

- Use `blog-publisher` skill to publish finished posts
- Use `site-deployer` skill to deploy content sites
- Use `voice-clone` skill to create audio versions
- Use `research-scout` findings as content fuel
- Store all content in workspace for version history
