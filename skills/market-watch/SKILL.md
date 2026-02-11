# Skill: Market Watch (Intel Radar)

## Description

Proactively scans specific market sectors (AI Tools, Side Hustles) for high-signal trends, filters out noise, and delivers a concise intelligence brief.

## Usage

- User says: "Scan market trends for [Topic]" or "Run Intel Radar".
- Cron triggers: "Run Intel Radar Daily Brief".

## Implementation Details

### 1. Monitoring Targets

- **AI Tools**: Focus on "Product Hunt", "Hacker News", "GitHub Trending". Keywords: "productivity", "coding assistant", "automation".
- **Side Hustle**: Focus on "Reddit (r/sidehustle, r/entrepreneur)", "Indie Hackers". Keywords: "revenue", "case study", "validated".

### 2. Execution Flow

1.  **Search**: Use `web_search` with time filter (past 24h/week).
    - Query examples: `site:producthunt.com "AI" after:24h`, `site:reddit.com/r/sidehustle "revenue" after:24h`.
2.  **Filter**:
    - Discard: "Top 10..." listicles, generic marketing, zero-comment posts.
    - Keep: Real launches, revenue reports, detailed discussions.
3.  **Fetch**: Use `web_fetch` on the top 3-5 promising URLs.
4.  **Synthesize**:
    - Generate a "Daily Brief" in Markdown.
    - Structure:
      - **🚨 Headline**: The most important finding.
      - **🛠️ Tools**: New & noteworthy.
      - **💰 Opportunities**: Validated ideas.
      - **🔗 Links**: Direct sources.
5.  **Deliver**:
    - If interactive: Reply in chat.
    - If cron/headless: Use `message` tool to send to Telegram (Target: `Yee` or configured channel).

## Configuration

- Default Topics: `["AI Tools", "Side Hustle"]`
- Delivery Channel: `telegram`
