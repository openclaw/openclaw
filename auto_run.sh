#!/bin/bash
 set -e
 echo "====================================="
 echo "🚀 KUNGFUTRADER 实战全自动交易系统"
 echo "回测 → 验收益 → 画图 → 监控 → 实盘"
 echo "====================================="
 echo "📊 自动回测中..."
 python backtest.py --start_date 2023-01-01 --end_date 2026-02-28 --initial_capital 100000 --output ./backtest_report.json
 echo "🔍 实战收益校验：回撤>15%自动禁止实盘"
 python -c "
 import json
 with open('backtest_report.json') as f:
     r = json.load(f)
 if r['max_drawdown'] > 0.15:
     print('❌ 实盘已自动禁止：风险超标')
     exit(1)
 print('✅ 回测合格，允许实盘')
 "
 echo "📈 自动生成收益图、分析报告"
 python visualize_backtest.py --report ./backtest_report.json --output_image ./backtest_report.png --output_md ./backtest_report.md
 echo "🌐 启动实战监控面板（后台）"
 python app.py &
 echo "💹 24小时AI自动实盘交易中（无人值守）"
 while true; do sleep 60; done
