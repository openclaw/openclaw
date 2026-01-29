---
name: helium-10
description: Amazon seller research tool suite for product research, keyword research, listing optimization, and competitor analysis. Use when working with Helium 10 tools including Black Box (product discovery), Cerebro (reverse ASIN keyword lookup), Magnet (seed keyword expansion), Xray (Chrome extension market analysis), Listing Builder, Keyword Tracker, and Adtomic (PPC). Covers browser automation strategies for Helium 10's web interface.
---

# Helium 10 Skill

Helium 10 is a comprehensive Amazon seller toolkit with 30+ tools. This skill covers the core tools and automation strategies.

## Quick Reference: Core Tools

| Tool | Purpose | Input | Key Output |
|------|---------|-------|------------|
| **Black Box** | Product discovery | Filters (category, price, revenue) | Product opportunities |
| **Cerebro** | Reverse ASIN lookup | Up to 10 ASINs | Keywords competitors rank for |
| **Magnet** | Keyword expansion | Seed keyword(s) | Related keywords with volume |
| **Xray** | Market analysis | Amazon search page | Sales/revenue/review data |
| **Listing Builder** | Listing creation | Keywords | Optimized listing copy |
| **Keyword Tracker** | Rank monitoring | ASINs + keywords | Daily rank positions |

## Tool Access Methods

### Web Interface (members.helium10.com)
- Full access to all tools
- Best for: Complex research, bulk operations, exports

### Chrome Extension (free)
- Xray, ASIN Grabber, Profitability Calculator, Review Insights
- Best for: Quick analysis while browsing Amazon
- Install: Chrome Web Store → "Helium 10"

## Browser Automation Notes

**Known Issues:**
- Cerebro search input has React autocomplete that corrupts typed input
- Input field merges keystrokes with autocomplete suggestions

**Workarounds:**
1. **Multi-ASIN batch**: Cerebro accepts up to 10 ASINs at once - batch searches
2. **URL navigation**: Navigate directly with ASIN in URL path when possible
3. **JavaScript evaluate**: Use `document.querySelector` to set input values directly
4. **Chrome Extension**: Xray's "Keywords" link opens Cerebro with ASIN pre-filled
5. **Export from Xray**: Select ASINs in Xray → "Run keyword search" → Opens Cerebro

**Reliable Automation Pattern:**
```javascript
// Set value via JS rather than typing
const input = document.querySelector('[data-testid="cerebro-input"]') 
   || document.querySelector('input[placeholder*="ASIN"]');
if (input) {
  input.value = 'B0BKH9QVT3';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
```

## Workflow: Keyword Research for Existing Product

1. **Gather competitor ASINs** (up to 10)
   - Use Xray on Amazon search results
   - Pick top sellers with good reviews in your niche

2. **Run Cerebro multi-ASIN search**
   - Paste all ASINs (comma or space separated)
   - Click "Get Keywords"

3. **Apply filters** (recommended starting point):
   - Search Volume: Min 500-1000
   - Position Rank: 1-25 (where competitors actually rank)
   - Ranking Competitors: Min 7+ (keywords ALL competitors rank for)

4. **Export results**
   - CSV/XLSX for spreadsheet analysis
   - Direct to Frankenstein for processing
   - Add to Keyword Tracker for monitoring

## Workflow: Product Research with Black Box

1. **Set marketplace** (US, UK, etc.)
2. **Apply main filters**:
   - Category (optional)
   - Price: $20-60 (impulse purchase range)
   - Monthly Revenue: Min $5,000-10,000
3. **Apply advanced filters**:
   - Review Count: 10-150 (opportunity range)
   - Review Rating: Min 3.5
   - BSR: Max 50,000
4. **Validate with Xray** - check historical trends
5. **Confirm demand with Cerebro** - ensure keyword depth

## Key Metrics to Understand

### Cerebro IQ Score
`Search Volume / Competing Products`
- High score = good opportunity (high demand, low competition)

### Magnet IQ Score
Same formula - identifies promising seed keywords

### CPR (Cerebro Product Rank)
Estimated sales needed to rank on page 1 for a keyword

### Title Density
How many page-1 products have the keyword in their title
- High density = important to include in your title

## Plan Limits

| Plan | Cerebro/day | Magnet/day | Price |
|------|-------------|------------|-------|
| Free | Demo only | Demo only | $0 |
| Starter | 2 | 2 | $39/mo |
| Platinum | 250 | 150 | $99/mo |
| Diamond | Unlimited | 150 | $279/mo |

**API Access**: Enterprise plan only (custom pricing, requires sales call)

## Detailed Guides

- [references/cerebro.md](references/cerebro.md) - Complete Cerebro guide with all filters
- [references/black-box.md](references/black-box.md) - Product research filters and strategies
- [references/chrome-extension.md](references/chrome-extension.md) - Xray and extension tools
- [references/automation.md](references/automation.md) - Browser automation patterns

## Tips from Power Users

1. **Reverse-engineer long-tails from negative reviews** - customer complaints reveal product versions people wish existed
2. **Check "Customers say" snippets** - Amazon pulls real user language that tools miss
3. **Use Cerebro + Magnet together** - Magnet for breadth, Cerebro for validation
4. **Track keyword trends monthly** - Diamond plan shows month-over-month rank changes
5. **Save filter presets in Black Box** - reuse your winning filter combinations
