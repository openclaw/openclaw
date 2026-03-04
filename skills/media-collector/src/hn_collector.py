#!/usr/bin/env python3
"""
Hacker News 内容收集器
收集热门、最新、Ask HN、Show HN 等内容
"""

import argparse
import json
import requests
from datetime import datetime
from pathlib import Path

HN_API = "https://hacker-news.firebaseio.com/v0"
OUTPUT_DIR = Path(__file__).parent.parent / "output" / datetime.now().strftime("%Y-%m-%d")

def fetch_item(item_id):
    """获取单个项目详情"""
    try:
        resp = requests.get(f"{HN_API}/item/{item_id}.json", timeout=10)
        return resp.json() if resp.ok else None
    except:
        return None

def get_top_stories(limit=30, min_score=50):
    """获取热门故事"""
    resp = requests.get(f"{HN_API}/topstories.json", timeout=10)
    if not resp.ok:
        return []
    
    top_ids = resp.json()[:limit]
    stories = []
    
    for item_id in top_ids:
        item = fetch_item(item_id)
        if item and item.get('score', 0) >= min_score:
            stories.append({
                'id': item_id,
                'title': item.get('title', ''),
                'url': item.get('url', ''),
                'score': item.get('score', 0),
                'by': item.get('by', ''),
                'descendants': item.get('descendants', 0),
                'time': datetime.fromtimestamp(item.get('time', 0)).isoformat(),
                'type': item.get('type', 'story'),
                'source': 'hackernews'
            })
    
    return sorted(stories, key=lambda x: x['score'], reverse=True)

def get_new_stories(limit=30):
    """获取最新故事"""
    resp = requests.get(f"{HN_API}/newstories.json", timeout=10)
    if not resp.ok:
        return []
    
    new_ids = resp.json()[:limit]
    stories = []
    
    for item_id in new_ids:
        item = fetch_item(item_id)
        if item:
            stories.append({
                'id': item_id,
                'title': item.get('title', ''),
                'url': item.get('url', ''),
                'score': item.get('score', 0),
                'by': item.get('by', ''),
                'time': datetime.fromtimestamp(item.get('time', 0)).isoformat(),
                'type': item.get('type', 'story'),
                'source': 'hackernews'
            })
    
    return stories

def save_stories(stories, filename="hn_stories"):
    """保存故事到文件"""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    # Markdown 格式
    md_file = OUTPUT_DIR / f"{filename}.md"
    with open(md_file, 'w') as f:
        f.write(f"# Hacker News 热门内容\n\n")
        f.write(f"*收集时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*\n\n")
        f.write(f"共 {len(stories)} 条内容\n\n")
        f.write("---\n\n")
        
        for i, story in enumerate(stories, 1):
            f.write(f"## {i}. {story['title']}\n\n")
            if story.get('url'):
                f.write(f"**链接**: [{story['url']}]({story['url']})\n\n")
            f.write(f"**分数**: {story['score']} | **评论**: {story.get('descendants', 0)} | **作者**: {story.get('by', 'N/A')}\n\n")
            f.write(f"**时间**: {story['time']}\n\n")
            f.write("---\n\n")
    
    # JSON 格式
    json_file = OUTPUT_DIR / f"{filename}.json"
    with open(json_file, 'w') as f:
        json.dump({
            'collected_at': datetime.now().isoformat(),
            'source': 'hackernews',
            'count': len(stories),
            'stories': stories
        }, f, indent=2, ensure_ascii=False)
    
    print(f"✓ 已保存 {len(stories)} 条故事")
    print(f"  Markdown: {md_file}")
    print(f"  JSON: {json_file}")

def main():
    parser = argparse.ArgumentParser(description='收集 Hacker News 内容')
    parser.add_argument('--type', choices=['top', 'new', 'ask', 'show'], default='top',
                        help='内容类型 (default: top)')
    parser.add_argument('--limit', type=int, default=30, help='数量限制 (default: 30)')
    parser.add_argument('--min-score', type=int, default=50, help='最低分数 (default: 50)')
    parser.add_argument('--output', type=str, default=None, help='输出文件名')
    
    args = parser.parse_args()
    
    print(f"📰 收集 Hacker News {args.type} 内容...")
    
    if args.type == 'top':
        stories = get_top_stories(args.limit, args.min_score)
    elif args.type == 'new':
        stories = get_new_stories(args.limit)
    else:
        # Ask/Show HN 需要额外处理
        stories = get_top_stories(args.limit, args.min_score)
    
    if not stories:
        print("⚠ 未找到符合条件的内容")
        return
    
    output_name = args.output or f"hn_{args.type}"
    save_stories(stories, output_name)
    
    # 显示摘要
    print(f"\n📊 摘要:")
    print(f"  最高分：{max(s['score'] for s in stories)}")
    print(f"  平均分：{sum(s['score'] for s in stories) / len(stories):.1f}")
    print(f"  总评论：{sum(s.get('descendants', 0) for s in stories)}")

if __name__ == '__main__':
    main()
