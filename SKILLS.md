# Money Maker Bot - Custom Financial Skills

This document describes the custom financial skills included in this fork of Clawdbot.

## Overview

Money Maker Bot includes three specialized skills for financial analysis:

| Skill         | Purpose                                     | API Required                       |
| ------------- | ------------------------------------------- | ---------------------------------- |
| `sports-odds` | Compare betting lines across sportsbooks    | The Odds API (free tier available) |
| `nft-tracker` | Monitor NFT floor prices and whale activity | Reservoir API (free)               |
| `data-viz`    | Generate terminal charts from data          | None                               |

## Sports Odds Analyzer

### Description

Compare betting lines across multiple sportsbooks to find value bets. Supports NFL, NBA, MLB, NHL, and MLS with real-time odds.

### Setup

```bash
export ODDS_API_KEY="your-key-from-the-odds-api.com"
```

Get a free API key at [the-odds-api.com](https://the-odds-api.com) (500 requests/month on free tier).

### Usage Examples

**Get NFL spreads:**

```
"Show me NFL spreads for this week"
```

**Find value bets:**

```
"Compare the Lakers vs Celtics line across DraftKings, FanDuel, and BetMGM"
```

**Track line movement:**

```
"Has the Chiefs spread moved in the last hour?"
```

### Supported Sports

- NFL (americanfootball_nfl)
- NBA (basketball_nba)
- MLB (baseball_mlb)
- NHL (icehockey_nhl)
- MLS (soccer_usa_mls)

## NFT Price Tracker

### Description

Monitor floor prices, sales volume, and whale activity for top Ethereum NFT collections.

### Setup

```bash
# Optional - Reservoir API works without a key for basic requests
export RESERVOIR_API_KEY="your-reservoir-api-key"
```

### Usage Examples

**Check floor price:**

```
"What's the BAYC floor price right now?"
```

**Track whale activity:**

```
"Show me large MAYC sales in the last 24 hours"
```

**Compare collections:**

```
"Compare floor prices for BAYC, MAYC, and Azuki"
```

### Supported Collections

- Bored Ape Yacht Club (BAYC)
- Mutant Ape Yacht Club (MAYC)
- CryptoPunks
- Azuki
- Pudgy Penguins
- Doodles
- And many more via contract address

## Data Visualization

### Description

Generate charts and graphs directly in your terminal from CSV/JSON data.

### Setup

```bash
# Install visualization tools
brew install youplot  # macOS
# or
pip install termgraph
```

### Usage Examples

**Bar chart:**

```
"Create a bar chart of my portfolio allocation: BTC 45%, ETH 30%, SOL 15%, Other 10%"
```

**Line chart:**

```
"Plot my daily P&L for the last week"
```

**Histogram:**

```
"Show distribution of my bet sizes"
```

### Supported Chart Types

- Bar charts
- Line charts
- Histograms
- Scatter plots
- Box plots

## Model Configuration

For best results with financial analysis, configure model fallback to handle rate limits:

```yaml
# In your workspace config
models:
  primary: claude-3-5-sonnet
  fallback:
    - claude-3-haiku
    - gpt-4-turbo

  # Use specialized models for specific tasks
  research: perplexity # For web search and market research
  analysis: claude-3-5-sonnet # For detailed financial analysis
```

## Tips for Financial Analysis

1. **Always verify data** - Cross-reference odds/prices with official sources
2. **Set alerts** - Use cron jobs to monitor price movements
3. **Track your bets** - Keep a log of all wagers for analysis
4. **Bankroll management** - Never bet more than 1-5% of your bankroll on a single wager

## Contributing

Found a bug or want to add a new skill? See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Disclaimer

This software is for educational and entertainment purposes only. Sports betting and NFT trading involve financial risk. Always gamble responsibly and never invest more than you can afford to lose.
