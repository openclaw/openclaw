#!/bin/bash
# 价格检查工具 - 支持 BTC/ETH/HYPE/SOL/美股

# 默认检查的代币
COINS="bitcoin,ethereum,hyperliquid,solana"

show_help() {
  echo "用法: $0 [选项]"
  echo ""
  echo "选项:"
  echo "  -c, --coins 代币列表 (逗号分隔)"
  echo "  -h, --help   显示帮助"
  echo ""
  echo "示例:"
  echo "  $0                    # 检查默认代币"
  echo "  $0 -c btc,eth,sol    # 检查 BTC ETH SOL"
  echo "  $0 -c mstr,coin      # 检查 MSTR COIN"
}

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    -c|--coins)
      COINS="$2"
      shift 2
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo "未知参数: $1"
      show_help
      exit 1
      ;;
  esac
done

# 打印表头
printf "%-15s %12s %12s\n" "代币" "价格" "24h 涨跌"
printf "%-15s %12s %12s\n" "------" "------" "------"

# 检查加密货币
for coin in $(echo "$COINS" | tr ',' ' '); do
  case $coin in
    btc|bitcoin)
      ID="bitcoin"
      ;;
    eth|ethereum)
      ID="ethereum"
      ;;
    hype|hyperliquid)
      ID="hyperliquid"
      ;;
    sol|solana)
      ID="solana"
      ;;
    mstr)
      ID="microsoft"
      ;;
    coin|coinbase)
      ID="coinbase"
      ;;
    *)
      ID="$coin"
      ;;
  esac
  
  DATA=$(curl -s "https://api.coingecko.com/api/v3/simple/price?ids=$ID&vs_currencies=usd&include_24hr_change=true" 2>/dev/null)
  if [ -n "$DATA" ] && [ "$DATA" != "{}" ]; then
    PRICE=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin).get('$ID',{}); print(d.get('usd','N/A'))" 2>/dev/null)
    CHANGE=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin).get('$ID',{}); print(d.get('usd_24h_change','N/A'))" 2>/dev/null)
    
    if [ "$PRICE" != "N/A" ] && [ "$PRICE" != "" ]; then
      CHANGE_FMT=$(printf "%+.2f" "$CHANGE" 2>/dev/null || echo "N/A")
      printf "%-15s \$%11s %11s%%\n" "$coin" "$PRICE" "$CHANGE_FMT"
    fi
  fi
done
