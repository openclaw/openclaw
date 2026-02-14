---
name: sports-odds
description: "Get live sports betting odds and compare lines across sportsbooks. Supports NFL, NBA, MLB, NHL, and more."
homepage: https://the-odds-api.com/
metadata:
  {
    "openclaw":
      {
        "emoji": "🏈",
        "requires": { "bins": ["curl", "jq"] },
        "credentials":
          [
            {
              "id": "odds-api-key",
              "name": "The Odds API Key",
              "description": "Free API key from https://the-odds-api.com/",
              "env": "ODDS_API_KEY",
            },
          ],
      },
  }
---

# Sports Betting Odds

Get live betting odds from multiple sportsbooks using The Odds API. Free tier includes 500 requests/month.

## Setup

1. Get a free API key at https://the-odds-api.com/
2. Set the environment variable: `export ODDS_API_KEY=your_key_here`

## Available Sports

List all available sports:

```bash
curl -s "https://api.the-odds-api.com/v4/sports?apiKey=$ODDS_API_KEY" | jq '.[] | {key, title, active}'
```

Common sport keys:
- `americanfootball_nfl` - NFL
- `basketball_nba` - NBA
- `baseball_mlb` - MLB
- `icehockey_nhl` - NHL
- `soccer_epl` - English Premier League
- `soccer_usa_mls` - MLS

## Get Odds

Get current odds for a sport (NFL example):

```bash
curl -s "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?apiKey=$ODDS_API_KEY&regions=us&markets=h2h,spreads,totals" | jq '.'
```

### Compact odds view:

```bash
curl -s "https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?apiKey=$ODDS_API_KEY&regions=us&markets=h2h" | jq '.[] | {game: "\(.home_team) vs \(.away_team)", commence: .commence_time, bookmakers: [.bookmakers[] | {name: .title, odds: .markets[0].outcomes}]}'
```

### Compare spreads across books:

```bash
curl -s "https://api.the-odds-api.com/v4/sports/basketball_nba/odds?apiKey=$ODDS_API_KEY&regions=us&markets=spreads" | jq '.[] | {matchup: "\(.away_team) @ \(.home_team)", books: [.bookmakers[] | {book: .title, spread: .markets[0].outcomes[0]}]}'
```

## Markets

- `h2h` - Moneyline (head-to-head)
- `spreads` - Point spreads
- `totals` - Over/under totals

## Regions

- `us` - US sportsbooks (DraftKings, FanDuel, BetMGM, etc.)
- `uk` - UK bookmakers
- `eu` - European bookmakers
- `au` - Australian bookmakers

## Best Line Finder

Find the best available line for a game:

```bash
# Get best moneyline odds
curl -s "https://api.the-odds-api.com/v4/sports/basketball_nba/odds?apiKey=$ODDS_API_KEY&regions=us&markets=h2h" | jq '
  .[] | 
  {
    game: "\(.away_team) @ \(.home_team)",
    best_home: (.bookmakers | map(.markets[0].outcomes[] | select(.name == .home_team)) | max_by(.price)),
    best_away: (.bookmakers | map(.markets[0].outcomes[] | select(.name == .away_team)) | max_by(.price))
  }
'
```

## Check API Usage

```bash
curl -s "https://api.the-odds-api.com/v4/sports?apiKey=$ODDS_API_KEY" -D - 2>&1 | grep -i "x-requests"
```

Headers show: `x-requests-used` and `x-requests-remaining`

## Tips

- Cache responses to save API calls
- Use `oddsFormat=american` or `oddsFormat=decimal` parameter
- Free tier: 500 requests/month, paid plans available for more
