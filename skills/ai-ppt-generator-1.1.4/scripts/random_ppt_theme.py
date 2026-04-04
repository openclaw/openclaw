#!/usr/bin/env python3
"""
Random PPT Theme Selector
If user doesn't select a PPT template, this script will randomly select one
from the available templates and generate PPT.
"""

import os
import sys
import json
import random
import argparse
import subprocess
import time
def get_available_themes():
    """Get available PPT themes"""
    try:
        api_key = os.getenv("BAIDU_API_KEY")
        if not api_key:
            print("Error: BAIDU_API_KEY environment variable not set", file=sys.stderr)
            return []
        
        # Import the function from ppt_theme_list.py
        script_dir = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, script_dir)
        
        from ppt_theme_list import ppt_theme_list as get_themes
        themes = get_themes(api_key)
        return themes
    except Exception as e:
        print(f"Error getting themes: {e}", file=sys.stderr)
        return []



def categorize_themes(themes):
    """Categorize themes by style for better random selection"""
    categorized = {
        "企业商务": [],
        "文艺清新": [],
        "卡通手绘": [],
        "扁平简约": [],
        "中国风": [],
        "年终总结": [],
        "创意趣味": [],
        "文化艺术": [],
        "未来科技": [],
        "默认": []
    }
    
    for theme in themes:
        style_names = theme.get("style_name_list", [])
        if not style_names:
            categorized["默认"].append(theme)
            continue
            
        added = False
        for style_name in style_names:
            if style_name in categorized:
                categorized[style_name].append(theme)
                added = True
                break
        
        if not added:
            categorized["默认"].append(theme)
    
    return categorized


def select_random_theme_by_category(categorized_themes, preferred_category=None):
    """Select a random theme, optionally preferring a specific category"""
    # If preferred category specified and has themes, use it
    if preferred_category and preferred_category in categorized_themes:
        if categorized_themes[preferred_category]:
            return random.choice(categorized_themes[preferred_category])
    
    # Otherwise, select from all non-empty categories
    available_categories = []
    for category, themes in categorized_themes.items():
        if themes:
            available_categories.append(category)
    
    if not available_categories:
        return None
    
    # Weighted random selection: prefer non-default categories
    weights = []
    for category in available_categories:
        if category == "默认":
            weights.append(0.5)  # Lower weight for default
        else:
            weights.append(2.0)  # Higher weight for specific styles
    
    # Normalize weights
    total_weight = sum(weights)
    weights = [w/total_weight for w in weights]
    
    selected_category = random.choices(available_categories, weights=weights, k=1)[0]
    return random.choice(categorized_themes[selected_category])


def suggest_category_by_query(query):
    """Suggest template category based on query keywords - enhanced version"""
    query_lower = query.lower()
    
    # Comprehensive keyword mapping with priority order
    keyword_mapping = [
        # Business & Corporate (highest priority for formal content)
        ("企业商务", [
            "企业", "公司", "商务", "商业", "商务", "商业计划", "商业报告",
            "营销", "市场", "销售", "财务", "会计", "审计", "投资", "融资",
            "战略", "管理", "运营", "人力资源", "hr", "董事会", "股东",
            "年报", "季报", "财报", "业绩", "kpi", "okr", "商业计划书",
            "提案", "策划", "方案", "报告", "总结", "规划", "计划"
        ]),
        
        # Technology & Future Tech
        ("未来科技", [
            "未来", "科技", "人工智能", "ai", "机器学习", "深度学习",
            "大数据", "云计算", "区块链", "物联网", "iot", "5g", "6g",
            "量子计算", "机器人", "自动化", "智能制造", "智慧城市",
            "虚拟现实", "vr", "增强现实", "ar", "元宇宙", "数字孪生",
            "芯片", "半导体", "集成电路", "电子", "通信", "网络",
            "网络安全", "信息安全", "数字化", "数字化转型",
            "科幻", "高科技", "前沿科技", "科技创新", "技术"
        ]),
        
        # Education & Children
        ("卡通手绘", [
            "卡通", "动画", "动漫", "儿童", "幼儿", "小学生", "中学生",
            "教育", "教学", "课件", "教案", "学习", "培训", "教程",
            "趣味", "有趣", "可爱", "活泼", "生动", "绘本", "漫画",
            "手绘", "插画", "图画", "图形", "游戏", "玩乐", "娱乐"
        ]),
        
        # Year-end & Summary
        ("年终总结", [
            "年终", "年度", "季度", "月度", "周报", "日报",
            "总结", "回顾", "汇报", "述职", "考核", "评估",
            "成果", "成绩", "业绩", "绩效", "目标", "完成",
            "工作汇报", "工作总结", "年度报告", "季度报告"
        ]),
        
        # Minimalist & Modern Design
        ("扁平简约", [
            "简约", "简洁", "简单", "极简", "现代", "当代",
            "设计", "视觉", "ui", "ux", "用户体验", "用户界面",
            "科技感", "数字感", "数据", "图表", "图形", "信息图",
            "分析", "统计", "报表", "dashboard", "仪表板",
            "互联网", "web", "移动", "app", "应用", "软件"
        ]),
        
        # Chinese Traditional
        ("中国风", [
            "中国", "中华", "传统", "古典", "古风", "古代",
            "文化", "文明", "历史", "国学", "东方", "水墨",
            "书法", "国画", "诗词", "古文", "经典", "传统节日",
            "春节", "中秋", "端午", "节气", "风水", "易经",
            "儒", "道", "佛", "禅", "茶道", "瓷器", "丝绸"
        ]),
        
        # Cultural & Artistic
        ("文化艺术", [
            "文化", "艺术", "文艺", "美学", "审美", "创意",
            "创作", "作品", "展览", "博物馆", "美术馆", "画廊",
            "音乐", "舞蹈", "戏剧", "戏曲", "电影", "影视",
            "摄影", "绘画", "雕塑", "建筑", "设计", "时尚",
            "文学", "诗歌", "小说", "散文", "哲学", "思想"
        ]),
        
        # Artistic & Fresh
        ("文艺清新", [
            "文艺", "清新", "小清新", "治愈", "温暖", "温柔",
            "浪漫", "唯美", "优雅", "精致", "细腻", "柔和",
            "自然", "生态", "环保", "绿色", "植物", "花卉",
            "风景", "旅行", "游记", "生活", "日常", "情感"
        ]),
        
        # Creative & Fun
        ("创意趣味", [
            "创意", "创新", "创造", "发明", "新奇", "新颖",
            "独特", "个性", "特色", "趣味", "有趣", "好玩",
            "幽默", "搞笑", "笑话", "娱乐", "休闲", "放松",
            "脑洞", "想象力", "灵感", "点子", "想法", "概念"
        ]),
        
        # Academic & Research
        ("默认", [
            "研究", "学术", "科学", "论文", "课题", "项目",
            "实验", "调查", "分析", "理论", "方法", "技术",
            "医学", "健康", "医疗", "生物", "化学", "物理",
            "数学", "工程", "建筑", "法律", "政治", "经济",
            "社会", "心理", "教育", "学习", "知识", "信息"
        ])
    ]
    
    # Check each category with its keywords
    for category, keywords in keyword_mapping:
        for keyword in keywords:
            if keyword in query_lower:
                return category
    
    # If no match found, analyze query length and content
    words = query_lower.split()
    if len(words) <= 3:
        # Short query, likely specific - use "默认" or tech-related
        if any(word in query_lower for word in ["ai", "vr", "ar", "iot", "5g", "tech"]):
            return "未来科技"
        return "默认"
    else:
        # Longer query, analyze word frequency
        word_counts = {}
        for word in words:
            if len(word) > 1:  # Ignore single characters
                word_counts[word] = word_counts.get(word, 0) + 1
        
        # Check for business indicators
        business_words = ["报告", "总结", "计划", "方案", "业绩", "销售", "市场"]
        if any(word in word_counts for word in business_words):
            return "企业商务"
        
        # Check for tech indicators
        tech_words = ["技术", "科技", "数据", "数字", "智能", "系统"]
        if any(word in word_counts for word in tech_words):
            return "未来科技"
        
        # Default fallback
        return "默认"


def generate_ppt_with_random_theme(query, preferred_category=None):
    """Generate PPT with randomly selected theme"""
    # Get available themes
    themes = get_available_themes()
    if not themes:
        print("Error: No available themes found", file=sys.stderr)
        return False
    
    # Categorize themes
    categorized = categorize_themes(themes)
    
    # Select random theme
    selected_theme = select_random_theme_by_category(categorized, preferred_category)
    if not selected_theme:
        print("Error: Could not select a theme", file=sys.stderr)
        return False
    
    style_id = selected_theme.get("style_id", 0)
    tpl_id = selected_theme.get("tpl_id")
    style_names = selected_theme.get("style_name_list", ["默认"])
    
    print(f"Selected template: {style_names[0]} (tpl_id: {tpl_id})", file=sys.stderr)
    
    # Generate PPT
    script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate_ppt.py")
    
    try:
        # Run generate_ppt.py with the selected theme
        cmd = [
            sys.executable, script_path,
            "--query", query,
            "--tpl_id", str(tpl_id),
            "--style_id", str(style_id)
        ]
        
        start_time = int(time.time())
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            universal_newlines=True
        )
        
        # Stream output
        for line in process.stdout:
            line = line.strip()
            if line:
                try:
                    data = json.loads(line)
                    if "is_end" in data and data["is_end"]:
                        print(json.dumps(data, ensure_ascii=False))
                    else:
                        end_time = int(time.time())
                        print(json.dumps({"status": data.get("status", "生成中"), "run_time": end_time - start_time}, ensure_ascii=False))
                except json.JSONDecodeError:
                    # Just print non-JSON output
                    print(line)
        
        process.wait()
        return process.returncode == 0
        
    except Exception as e:
        print(f"Error generating PPT: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Generate PPT with random theme selection")
    parser.add_argument("--query", "-q", type=str, required=True, help="PPT主题/内容")
    parser.add_argument("--category", "-c", type=str, help="Preferred category (企业商务/文艺清新/卡通手绘/扁平简约/中国风/年终总结/创意趣味/文化艺术/未来科技)")
    
    args = parser.parse_args()
    
    # Determine preferred category
    preferred_category = args.category
    if not preferred_category:
        preferred_category = suggest_category_by_query(args.query)
        if preferred_category:
            print(f"Auto-suggested category: {preferred_category}", file=sys.stderr)
    
    # Generate PPT
    success = generate_ppt_with_random_theme(args.query, preferred_category)
    
    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()