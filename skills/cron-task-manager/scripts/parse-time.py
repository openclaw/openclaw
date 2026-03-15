#!/usr/bin/env python3
"""
Parse natural language time expressions into ISO format or cron expressions.
"""

import sys
import re
from datetime import datetime, timedelta

def parse_time(text: str, now: datetime = None) -> dict:
    """
    Parse natural language time expression.
    Returns dict with 'type' (at/cron), 'value', and 'readable'.
    """
    if now is None:
        now = datetime.now()
    
    text = text.strip().lower()
    
    # Duration patterns: +30m, +2h, +1d
    duration_match = re.match(r'^\+(\d+)([mhd])$', text)
    if duration_match:
        amount = int(duration_match.group(1))
        unit = duration_match.group(2)
        if unit == 'm':
            target = now + timedelta(minutes=amount)
        elif unit == 'h':
            target = now + timedelta(hours=amount)
        else:  # 'd'
            target = now + timedelta(days=amount)
        return {
            'type': 'at',
            'value': target.strftime('%Y-%m-%dT%H:%M:%S'),
            'readable': f"{amount}{'分钟' if unit=='m' else '小时' if unit=='h' else '天'}后"
        }
    
    # Time of day patterns
    time_match = re.search(r'(\d{1,2})[:点](\d{2})?', text)
    hour = int(time_match.group(1)) if time_match else 21
    minute = int(time_match.group(2)) if time_match and time_match.group(2) else 0
    
    # "今晚"
    if '今晚' in text or '晚上' in text:
        target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        return {
            'type': 'at',
            'value': target.strftime('%Y-%m-%dT%H:%M:%S'),
            'readable': f"今晚 {hour:02d}:{minute:02d}"
        }
    
    # "明天"
    if '明天' in text or '明早' in text:
        target = (now + timedelta(days=1)).replace(hour=hour, minute=minute, second=0, microsecond=0)
        return {
            'type': 'at',
            'value': target.strftime('%Y-%m-%dT%H:%M:%S'),
            'readable': f"明天 {hour:02d}:{minute:02d}"
        }
    
    # "后天"
    if '后天' in text:
        target = (now + timedelta(days=2)).replace(hour=hour, minute=minute, second=0, microsecond=0)
        return {
            'type': 'at',
            'value': target.strftime('%Y-%m-%dT%H:%M:%S'),
            'readable': f"后天 {hour:02d}:{minute:02d}"
        }
    
    # Recurring patterns
    if '每天' in text or '每晚' in text:
        return {
            'type': 'cron',
            'value': f"{minute} {hour} * * *",
            'readable': f"每天 {hour:02d}:{minute:02d}"
        }
    
    if '每周一' in text or '每星期一' in text or '每个周一' in text:
        return {
            'type': 'cron',
            'value': f"{minute} {hour} * * 1",
            'readable': f"每周一 {hour:02d}:{minute:02d}"
        }
    
    if '每周' in text:
        # Map Chinese weekdays to cron numbers (0=Sunday)
        weekday_map = {'日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6}
        for cn, num in weekday_map.items():
            if f'周{cn}' in text or f'星期{cn}' in text:
                return {
                    'type': 'cron',
                    'value': f"{minute} {hour} * * {num}",
                    'readable': f"每周{cn} {hour:02d}:{minute:02d}"
                }
    
    # Default: assume today at specified time
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return {
        'type': 'at',
        'value': target.strftime('%Y-%m-%dT%H:%M:%S'),
        'readable': f"今天 {hour:02d}:{minute:02d}"
    }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: parse-time.py '<time-expression>'")
        print("Examples:")
        print("  parse-time.py '今晚9点'")
        print("  parse-time.py '明天早上8点'")
        print("  parse-time.py '+30m'")
        print("  parse-time.py '每天晚上10点'")
        sys.exit(1)
    
    result = parse_time(sys.argv[1])
    print(f"Type: {result['type']}")
    print(f"Value: {result['value']}")
    print(f"Readable: {result['readable']}")
