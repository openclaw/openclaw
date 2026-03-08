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
    python3 memory_quality_monitor.py              # Test mode
    python3 memory_quality_monitor.py report       # Generate 7-day report
    python3 memory_quality_monitor.py report 30    # Generate 30-day report

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
    """Log search result quality"""
    log_entry = {
        "timestamp": datetime.now().isoformat(),
        "query": query,
        "result_count": result_count,
        "max_score": round(max_score, 3) if max_score is not None else 0,
        "quality": "poor" if (result_count < 3 or max_score < 0.5) else "good",
        "source": source
    }
    
    # Append to log file
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
    
    return log_entry

def generate_quality_report(days=7):
    """Generate quality report for last N days"""
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
            except Exception:
                continue
    
    if not searches:
        return {"error": f"No searches in last {days} days"}
    
    # Statistics
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
            s for s in searches if s['quality'] == 'poor'
        ][-10:]
    }
    
    return report

def print_report(report):
    """Print quality report"""
    if "error" in report:
        print(f"⚠️  {report['error']}")
        return
    
    print("\n🌙 Memory Search Quality Report")
    print("=" * 60)
    print(f"Period: {report['period_days']} days")
    print(f"Total searches: {report['total_searches']}")
    print(f"Poor quality searches: {report['poor_quality_count']} ({report['poor_quality_rate']}%)")
    print(f"Avg results per search: {report['avg_results_per_search']}")
    print(f"Avg max score: {report['avg_max_score']}")
    
    if report['recent_poor_searches']:
        print("\n⚠️  Recent poor quality searches:")
        for search in report['recent_poor_searches']:
            print(f"  • \"{search['query']}\" → {search['result_count']} results, max score {search['max_score']}")
    
    print("\n" + "=" * 60)

def main():
    """Main function"""
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == 'report':
        # Report generation mode
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 7
        report = generate_quality_report(days)
        print_report(report)
    else:
        # Test mode
        print("🌙 Memory Quality Monitor Script")
        print("Usage:")
        print("  python3 memory_quality_monitor.py          # Test logging")
        print("  python3 memory_quality_monitor.py report   # Generate quality report")
        print("  python3 memory_quality_monitor.py report 30  # Generate 30-day report")
        
        # Example: log a search
        test_log = log_search_result("test_search", 5, 0.75, "test")
        print(f"\n✓ Test log entry created: {test_log}")

if __name__ == '__main__':
    main()
