---
name: data-viz
description: "Create data visualizations from the command line. Generate charts, graphs, and plots from CSV/JSON data without leaving the terminal."
homepage: https://github.com/red-data-tools/YouPlot
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "requires": { "bins": ["curl"] },
        "install":
          [
            {
              "id": "uplot-gem",
              "kind": "shell",
              "command": "gem install youplot",
              "bins": ["uplot"],
              "label": "Install YouPlot (Ruby gem)",
            },
            {
              "id": "termgraph-pip",
              "kind": "shell", 
              "command": "pip install termgraph",
              "bins": ["termgraph"],
              "label": "Install termgraph (Python)",
            },
          ],
      },
  }
---

# Data Visualization

Create terminal-based charts and visualizations from CSV, JSON, or piped data.

## Quick Visualizations with YouPlot

YouPlot (`uplot`) creates Unicode charts in the terminal.

### Bar Chart

```bash
echo -e "Apple,30\nBanana,45\nCherry,20\nDate,35" | uplot bar -d, -t "Fruit Sales"
```

### Line Chart

```bash
seq 1 20 | awk '{print $1, sin($1/3)*10+10}' | uplot line -t "Sine Wave"
```

### Histogram

```bash
awk 'BEGIN{for(i=0;i<1000;i++)print rand()}' | uplot hist -t "Random Distribution" -n 20
```

### Scatter Plot

```bash
awk 'BEGIN{for(i=0;i<100;i++)print rand()*100, rand()*100}' | uplot scatter -t "Random Points"
```

## From CSV Files

```bash
# Bar chart from CSV
cat sales.csv | uplot bar -d, -H -t "Monthly Sales"

# Line chart with headers
cat timeseries.csv | uplot line -d, -H -t "Stock Price"
```

## From JSON (with jq)

```bash
# Extract data from JSON and plot
curl -s "https://api.example.com/data" | jq -r '.items[] | "\(.name),\(.value)"' | uplot bar -d,
```

## Termgraph (Python Alternative)

Simple horizontal bar charts:

```bash
echo -e "2020 50\n2021 75\n2022 90\n2023 120" | termgraph
```

With colors:

```bash
echo -e "Sales 150\nCosts 80\nProfit 70" | termgraph --color green
```

## Gnuplot (Advanced)

For publication-quality charts:

```bash
# Quick line plot
gnuplot -e "set terminal dumb; plot sin(x)"

# From data file
gnuplot -e "set terminal dumb; plot 'data.txt' with lines"
```

## Sparklines

Inline mini-charts:

```bash
# Using spark (if installed)
echo "1 5 22 13 5" | spark
# Output: ▁▂█▅▂

# Pure bash sparkline
data="1 5 22 13 5"; min=$(echo $data | tr ' ' '\n' | sort -n | head -1); max=$(echo $data | tr ' ' '\n' | sort -n | tail -1); for n in $data; do printf "\u258$((7-7*($n-$min)/($max-$min)))"; done; echo
```

## ASCII Tables

Format data as tables:

```bash
# Using column
echo -e "Name,Score,Grade\nAlice,95,A\nBob,82,B\nCarol,78,C" | column -t -s,

# Using csvlook (csvkit)
cat data.csv | csvlook
```

## Real-World Examples

### Stock Price Chart

```bash
# Fetch and plot stock data (using Alpha Vantage free API)
curl -s "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=AAPL&apikey=demo" | \
  jq -r '.["Time Series (Daily)"] | to_entries | .[:20] | reverse | .[] | "\(.key) \(.value["4. close"])"' | \
  uplot line -t "AAPL Stock Price"
```

### System Metrics

```bash
# CPU usage over time
for i in {1..20}; do
  top -bn1 | grep "Cpu(s)" | awk '{print 100-$8}'
  sleep 1
done | uplot line -t "CPU Usage %"
```

### API Response Times

```bash
# Measure and plot response times
for i in {1..10}; do
  curl -s -o /dev/null -w "%{time_total}\n" https://example.com
done | uplot line -t "Response Time (s)"
```

## Tips

- Use `-d,` for comma-delimited data, `-d'\t'` for tabs
- Use `-H` when your data has headers
- Pipe through `head` or `tail` to limit data points
- Combine with `jq` for JSON data extraction
- Use `watch` for live updating charts: `watch -n1 'command | uplot bar'`
