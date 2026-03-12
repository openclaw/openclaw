#!/bin/bash
# 每日投资报告生成器

OUTPUT_DIR=${1:-.}

echo "# 每日投资观察 - $(date '+%Y-%m-%d')" > "$OUTPUT_DIR/daily-report.md"

# 加密货币
echo "## 加密货币" >> "$OUTPUT_DIR/daily-report.md"
echo "| 代币 | 价格 | 24h 涨跌 |" >> "$OUTPUT_DIR/daily-report.md"
echo "|------|------|---------|" >> "$OUTPUT_DIR/daily-report.md"

COINS="bitcoin,ethereum,hyperliquid,solana"
DATA=$(curl -s "https://api.coingecko.com/api/v3/simple/price?ids=$COINS&vs_currencies=usd&include_24hr_change=true")

for coin in bitcoin ethereum hyperliquid solana; do
  PRICE=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$coin',{}).get('usd','N/A'))")
  CHANGE=$(echo "$DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$coin',{}).get('usd_24h_change',0))")
  printf "| %s | \$%s | %+.2f%% |\n" "$coin" "$PRICE" "$CHANGE" >> "$OUTPUT_DIR/daily-report.md"
done

echo "" >> "$OUTPUT_DIR/daily-report.md"
echo "*生成于 $(date)*" >> "$OUTPUT_DIR/daily-report.md"

echo "✅ 报告已生成: $OUTPUT_DIR/daily-report.md"
cat "$OUTPUT_DIR/daily-report.md"
