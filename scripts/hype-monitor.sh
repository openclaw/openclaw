#!/bin/bash
# HYPE 价格监控脚本
# 用法: ./hype-monitor.sh [阈值]

THRESHOLD=${1:-25}
API_URL="https://api.coingecko.com/api/v3/simple/price?ids=hyperliquid&vs_currencies=usd"

while true; do
  PRICE=$(curl -s "$API_URL" | python3 -c "import sys,json; print(json.load(sys.stdin)['hyperliquid']['usd'])")
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
  
  echo "[$TIMESTAMP] HYPE: \$$PRICE"
  
  if (( $(echo "$PRICE < $THRESHOLD" | bc -l) )); then
    echo "🚨 低于 \$$THRESHOLD，可以买入！"
  fi
  
  sleep 300  # 5分钟检查一次
done
