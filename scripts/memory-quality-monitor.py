#!/usr/bin/env python3
"""
Memory Search Quality Monitor

Records memory_search quality metrics to detect silent failures.

Metrics tracked:
- Search query
- Result count
- Maximum similarity score
- Quality flag: "poor" if results<3 or max_score<0.5

Usage:
    python3 memory-quality-monitor.py              # Test mode
    python3 memory-quality-monitor.py report       # Generate 7-day report
    python3 memory-quality-monitor.py report 30    # Generate 30-day report

Integration example:
    from memory_quality_monitor import log_search_result
    
    results = memory_search("your query")
    log_search_result(
        query="your query",
        result_count=len(results),
        max_score=max(r.score for r in results) if results else 0
    )
"""

import os
import json
from datetime import datetime, timedelta

LOG_PATH = os.path.expanduser("~/.openclaw/workspace/memory/search-quality-log.jsonl")

def log_search_result(query, result_count, max_score, source="manual"):
    """记录搜索结果质量"""
    log_entry = {
        "timestamp": datetime.now().isoformat(),
        "query": query,
        "result_count": result_count,
        "max_score": round(max_score, 3) if max_score else 0,
        "quality": "poor" if (result_count < 3 or (max_score and max_score < 0.5)) else "good",
        "source": source
    }
    
    # 追加到日志文件
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
    
    return log_entry

def generate_quality_report(days=7):
    """生成质量报告（最近 N 天）"""
    if not os.path.exists(LOG_PATH):
        return {"error": "No search log found"}
    
    cutoff = datetime.now() - timedelta(days=days)
    searches = []
    
    with open(LOG_PATH, 'r', encoding='utf-8') as f:
        for line in f:
            try:
                entry = json.loads(line.strip())
                entry_time = datetime.fromisoformat(entry['timestamp'])
                if entry_time >= cutoff:
                    searches.append(entry)
            except:
                continue
    
    if not searches:
        return {"error": f"No searches in last {days} days"}
    
    # 统计
    total = len(searches)
    poor_quality = sum(1 for s in searches if s['quality'] == 'poor')
    avg_results = sum(s['result_count'] for s in searches) / total
    avg_max_score = sum(s['max_score'] for s in searches) / total
    
    report = {
        "period_days": days,
        "total_searches": total,
        "poor_quality_count": poor_quality,
        "poor_quality_rate": round(poor_quality / total * 100, 1),
        "avg_results_per_search": round(avg_results, 1),
        "avg_max_score": round(avg_max_score, 3),
        "recent_poor_searches": [
            s for s in searches[-10:] if s['quality'] == 'poor'
        ]
    }
    
    return report

def print_report(report):
    """打印质量报告"""
    if "error" in report:
        print(f"⚠️  {report['error']}")
        return
    
    print("\n🌙 银月记忆搜索质量报告")
    print("=" * 60)
    print(f"统计周期：{report['period_days']} 天")
    print(f"总搜索次数：{report['total_searches']}")
    print(f"低质量搜索：{report['poor_quality_count']} ({report['poor_quality_rate']}%)")
    print(f"平均结果数：{report['avg_results_per_search']}")
    print(f"平均最高分：{report['avg_max_score']}")
    
    if report['recent_poor_searches']:
        print("\n⚠️  最近低质量搜索:")
        for search in report['recent_poor_searches']:
            print(f"  • \"{search['query']}\" → {search['result_count']} 结果，最高分 {search['max_score']}")
    
    print("\n" + "=" * 60)

def main():
    """主函数"""
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == 'report':
        # 生成报告模式
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 7
        report = generate_quality_report(days)
        print_report(report)
    else:
        # 测试模式
        print("🌙 银月记忆质量监控脚本")
        print("用法:")
        print("  python3 memory-quality-monitor.py          # 测试日志记录")
        print("  python3 memory-quality-monitor.py report   # 生成质量报告")
        print("  python3 memory-quality-monitor.py report 30  # 生成 30 天报告")
        
        # 示例：记录一次搜索
        test_log = log_search_result("测试搜索", 5, 0.75, "test")
        print(f"\n✓ 测试日志记录成功：{test_log}")

if __name__ == '__main__':
    main()
