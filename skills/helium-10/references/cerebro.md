# Cerebro - Reverse ASIN Keyword Research

Cerebro analyzes competitor products to reveal the keywords they rank for.

## Access
- **Web**: members.helium10.com → Keyword Research → Cerebro
- **Chrome Extension**: Click "Keywords" link under any product in Xray
- **URL Pattern**: `https://members.helium10.com/cerebro?asin=B0BKH9QVT3`

## Basic Usage

1. Select marketplace (flag icon next to search)
2. Enter 1-10 ASINs (comma or space separated)
3. Click "Get Keywords"
4. Wait for results (can take a few minutes for multi-ASIN)

## Results Overview

### Keyword Distribution
- **Organic Keywords**: Natural search rankings
- **Sponsored Keywords**: PPC ad placements
- **Amazon Recommended**: Amazon's suggested keywords

### Word Frequency
Most common words across all keywords - useful for identifying core terms.

## Key Metrics

| Metric | Description | Use |
|--------|-------------|-----|
| Search Volume | Monthly searches | Demand indicator |
| Cerebro IQ Score | Volume ÷ Competitors | Opportunity score |
| Sponsored ASINs | # of ads using keyword | Competition indicator |
| Title Density | % of page-1 with keyword in title | Title importance |
| Keyword Sales | Est. monthly sales from keyword | Revenue potential |
| Competing Products | Products ranking for keyword | Saturation level |
| Position Rank | Organic rank (1-306) | Current visibility |
| Relative Rank | Rank vs other ASINs searched | Competitive position |

## Advanced Filters

### Search Volume
- Min: 500-1000 (filters out low-traffic terms)
- Max: Leave open unless targeting long-tail only

### Position Rank (Organic)
- 1-10: Page 1 keywords
- 1-25: Top 2-3 pages (main focus area)
- 100+: Keywords where product barely appears

### Sponsored Rank
Filter by PPC rank position to see where competitors advertise.

### Ranking Competitors (Multi-ASIN)
**Most powerful filter for multi-ASIN searches**
- Set min to 7-9 out of 10 ASINs
- Shows only keywords ALL/MOST competitors rank for
- These are the most relevant, validated keywords

### Word Count
- 1-2 words: Head terms (high volume, high competition)
- 3+ words: Long-tail (lower volume, easier to rank)

### Advanced Rank Filter
Find keywords where:
- Your product ranks poorly (page 3+)
- Competitors rank well (page 1)
= Opportunity keywords to target

## One-Click Filters

Quick filter buttons at top of results:
- **Top Keywords**: Highest search volume
- **Opportunity Keywords**: Good IQ score, lower competition
- **Sponsored Keywords**: Where competitors run PPC

## Export Options

### Export Data Button (Primary Export)
Click "Export Data..." button above the results table to open dropdown:
- **...as a CSV file**: Downloads to ~/Downloads as `US_AMAZON_cerebro_<ASIN>_<date>.csv`
- **...as a XLSX file**: Excel format
- **...to Keyword Processor**: Send to Helium 10's keyword processor
- **copy to Clipboard**: Quick copy

**Browser Automation Note**: The dropdown items are text elements, not buttons. Click directly on the text "...as a CSV file" to trigger download.

### Other Actions
- **Add to Keyword Tracker**: Monitor rankings over time
- **Add to Ads Campaign**: Push to Amazon PPC
- **Add to My List**: Save keyword list

### Export File Contents
CSV includes all columns:
- Keyword Phrase, ABA Click/Conv Share, Keyword Sales
- Cerebro IQ Score, Search Volume, Search Volume Trend
- H10 PPC Suggested Bid (min/max)
- Sponsored ASINs, Competing Products, CPR, Title Density
- Match type flags (Organic, Sponsored, Amazon Recommended, etc.)
- Individual ASIN ranking columns for each searched ASIN

## Best Practices

### Selecting ASINs to Analyze
1. Pick top 3-5 direct competitors (similar product, similar price)
2. Include 1-2 aspirational competitors (best sellers in category)
3. Mix review counts (some established, some newer)

### Recommended Filter Combination
```
Search Volume: Min 500
Position Rank: 1-50
Ranking Competitors: Min 7 (for 10-ASIN search)
Word Count: 2-5
```

### Exporting Strategy
1. Export unfiltered first (backup)
2. Apply filters and export filtered set
3. Sort by IQ Score for prioritization
4. Cross-reference with Magnet results

## Troubleshooting

### "No keywords found"
- ASIN may be too new
- Check marketplace selection
- Try parent ASIN instead of variation

### Results seem incomplete
- Product may have limited search visibility
- Try including more competitor ASINs
- Check if product is in correct category

### Slow loading
- Multi-ASIN searches take longer
- Large keyword sets (10k+) need time to render
- Use filters to reduce result set
