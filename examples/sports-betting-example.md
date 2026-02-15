# Sports Betting Analysis Example

This guide shows how to use Money Maker Bot for sports betting analysis.

## Setup

First, get your API key from [The Odds API](https://the-odds-api.com/) (free tier: 500 requests/month).

```bash
export ODDS_API_KEY="your-api-key-here"
```

## Finding Value Bets

### Compare NFL Spreads

Ask your bot to compare spreads across sportsbooks:

```
Compare the spreads for tonight's NFL games across DraftKings, FanDuel, and BetMGM.
Highlight any games where the spread differs by 2 or more points.
```

### NBA Moneyline Analysis

```
Show me the moneyline odds for all NBA games today.
Which games have the biggest discrepancy between books?
```

### Live Odds Tracking

```
Track the line movement for the Chiefs vs Bills game over the last hour.
Alert me if the spread moves more than 1.5 points.
```

## Example API Calls

### Get NFL Spreads

```bash
curl -s "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=$ODDS_API_KEY&regions=us&markets=spreads" | jq '.'
```

### Get NBA Totals

```bash
curl -s "https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=$ODDS_API_KEY&regions=us&markets=totals" | jq '.'
```

### Get MLB Moneylines

```bash
curl -s "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=$ODDS_API_KEY&regions=us&markets=h2h" | jq '.'
```

## Supported Sports

- NFL (americanfootball_nfl)
- NBA (basketball_nba)
- MLB (baseball_mlb)
- NHL (icehockey_nhl)
- MLS (soccer_usa_mls)
- NCAA Football (americanfootball_ncaaf)
- NCAA Basketball (basketball_ncaab)

## Setting Up Alerts

Configure Telegram alerts for value opportunities:

```yaml
# In your workspace config
alerts:
  telegram:
    enabled: true
    chat_id: "your-chat-id"
  triggers:
    - type: spread_difference
      threshold: 2.0
      sports: ["nfl", "nba"]
```

## Bankroll Management

The bot can help with stake sizing:

```
I have a $1000 bankroll. Using the Kelly Criterion,
what should I bet on a -110 line where I estimate 55% win probability?
```

## Disclaimer

Sports betting involves risk. This tool is for informational purposes only. Always gamble responsibly and within your means.
