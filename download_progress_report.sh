#!/bin/bash
# 论文下载进度报告生成脚本

echo "======================================"
echo "论文下载进度报告"
echo "生成时间: $(date)"
echo "======================================"
echo ""

# 统计已下载文件
DOWNLOADED_COUNT=$(ls -1 /Users/lizhihong/claw/thesis_refs/*.pdf 2>/dev/null | wc -l | tr -d ' ')
echo "📊 已下载PDF数量: $DOWNLOADED_COUNT"
echo ""

echo "📁 已下载文件列表:"
ls -lh /Users/lizhihong/claw/thesis_refs/*.pdf 2>/dev/null | awk '{print "  - " $9 " (" $5 ")"}'
echo ""

echo "======================================"
echo "下载来源统计"
echo "======================================"
echo "✅ Browser Subagent 自动下载: ~25篇"
echo "   - 批次1 (引用71-83): 12篇成功, 1篇失败(Kunkel-ACM)"
echo "   - 批次2 (引用84-95): 12篇成功, 1篇失败(Wang)"
echo "   - 批次3 (引用96-110): 部分成功"
echo ""
echo "✅ 手动curl下载: 1篇"
echo "   - Kellogg (Algorithmic management)"
echo ""

echo "======================================"
echo "待下载文献"
echo "======================================"
echo "❌ 被Cloudflare阻止:"
echo "   - [81] Kunkel - Let me explain (ACM)"
echo "   - [96] Glikson - Will you accept an AI colleague (ACM)"
echo ""
echo "❓ 未找到/待确认:"
echo "   - [85] Wang - Designing for transparency"
echo "   - [98] Lee - The algorithm says you should be fired"
echo ""
echo "⏳ 待下载 (引用38-70):"
echo "   - 约32篇英文文献"
echo ""
echo "⏳ 待下载 (中文文献):"
echo "   - 需要手动下载(CNKI验证码)"
echo ""

echo "======================================"
echo "下一步建议"
echo "======================================"
echo "1. 等待API配额恢复后继续自动下载 (约2小时)"
echo "2. 手动下载被Cloudflare阻止的论文"
echo "3. 通过学校图书馆下载中文文献"
echo "4. 整理已下载文献,重命名为规范格式"
echo ""
