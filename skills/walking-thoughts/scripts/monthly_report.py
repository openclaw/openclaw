#!/usr/bin/env python3
"""
月度分析报告脚本
每月1日运行，分析上个月的日记记录
"""

import os
import sys
import json
import argparse
import logging
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict

# 添加项目根目录到Python路径
project_root = Path(__file__).parent.parent
sys.path.append(str(project_root))

# 配置日志
log_dir = project_root / "logs"
log_dir.mkdir(exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_dir / "monthly.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

def get_previous_month():
    """获取上个月的年份和月份"""
    today = datetime.now()
    first_day_of_month = today.replace(day=1)
    last_month = first_day_of_month - timedelta(days=1)
    return last_month.year, last_month.month

def collect_monthly_entries(year, month):
    """收集指定月份的日记条目"""
    entries_dir = project_root / "data" / "entries"
    if not entries_dir.exists():
        logger.warning(f"日记条目目录不存在: {entries_dir}")
        return []
    
    # 构建月份前缀（如：2026-01）
    month_prefix = f"{year:04d}-{month:02d}"
    
    entries = []
    for entry_file in entries_dir.glob("*.md"):
        # 检查文件名是否包含该月份
        if month_prefix in entry_file.name:
            try:
                with open(entry_file, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # 提取基本信息
                entry_info = {
                    'file': entry_file.name,
                    'path': str(entry_file),
                    'content': content,
                    'size': len(content),
                    'timestamp': extract_timestamp(entry_file.name)
                }
                entries.append(entry_info)
                
            except Exception as e:
                logger.error(f"读取条目文件失败 {entry_file}: {str(e)}")
    
    logger.info(f"收集到 {len(entries)} 个{year}年{month}月的日记条目")
    return entries

def extract_timestamp(filename):
    """从文件名提取时间戳"""
    # 格式: YYYY-MM-DD_HHMMSS_*.md
    parts = filename.split('_')
    if len(parts) >= 2:
        date_part = parts[0]  # YYYY-MM-DD
        time_part = parts[1]  # HHMMSS
        if len(time_part) >= 6:
            time_formatted = f"{time_part[:2]}:{time_part[2:4]}:{time_part[4:6]}"
            return f"{date_part} {time_formatted}"
    return filename

def analyze_entries(entries):
    """分析日记条目"""
    if not entries:
        return {
            'total_entries': 0,
            'total_words': 0,
            'analysis_date': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            'period': '无数据'
        }
    
    # 基础统计
    total_words = sum(len(entry['content'].split()) for entry in entries)
    
    # 提取所有文本内容
    all_text = "\n\n".join(entry['content'] for entry in entries)
    
    # 简单分析（可以扩展为更复杂的分析）
    analysis = {
        'total_entries': len(entries),
        'total_words': total_words,
        'avg_words_per_entry': total_words // len(entries) if entries else 0,
        'date_range': {
            'start': min(entry['timestamp'] for entry in entries) if entries else '无',
            'end': max(entry['timestamp'] for entry in entries) if entries else '无'
        },
        'analysis_date': datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        'period': f"{entries[0]['timestamp'][:7] if entries else '未知'}"
    }
    
    return analysis

def generate_report(analysis, entries, year, month):
    """生成月度报告"""
    # 创建报告目录
    reports_dir = project_root / "data" / "reports" / "monthly"
    reports_dir.mkdir(parents=True, exist_ok=True)
    
    # 生成带时间戳的报告文件名
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_filename = f"monthly_report_{year:04d}_{month:02d}_{timestamp}.md"
    report_path = reports_dir / report_filename
    
    # 构建报告内容
    report_content = f"""# 📊 月度思考记录分析报告

## 报告信息
- **分析月份**: {year}年{month}月
- **生成时间**: {analysis['analysis_date']}
- **报告ID**: {timestamp}

## 📈 数据概览

### 基础统计
- **总记录数**: {analysis['total_entries']} 条
- **总字数**: {analysis['total_words']} 字
- **平均每条字数**: {analysis['avg_words_per_entry']} 字
- **记录时间范围**: {analysis['date_range']['start']} 至 {analysis['date_range']['end']}

### 记录详情
"""
    
    # 添加条目列表
    if entries:
        report_content += "\n#### 本月记录条目\n"
        for i, entry in enumerate(entries, 1):
            report_content += f"{i}. **{entry['timestamp']}** - {entry['file']}\n"
            # 显示前100个字符作为预览
            preview = entry['content'][:100].replace('\n', ' ') + "..."
            report_content += f"   > {preview}\n\n"
    
    # 添加分析总结
    report_content += f"""
## 📝 月度总结

### 记录习惯分析
- **记录频率**: 本月共记录 {analysis['total_entries']} 次
- **内容产出**: 平均每天记录约 {analysis['total_entries'] / 30:.1f} 条（按30天计算）
- **思考深度**: 平均每条 {analysis['avg_words_per_entry']} 字

### 建议与观察
1. **持续记录**: 保持每日思考记录的习惯
2. **定期回顾**: 建议每周回顾一次本月记录
3. **深度思考**: 可以尝试对特定主题进行更深入的记录

## 🔍 技术信息
- **分析脚本**: monthly_report.py
- **数据来源**: `data/entries/` 目录
- **报告保存**: `{report_path.relative_to(project_root)}`
- **下次分析**: 下个月1日上午9点

---

*报告生成时间: {analysis['analysis_date']}*
*散步思考记录系统 - 月度分析模块*
"""
    
    # 写入报告文件
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(report_content)
    
    logger.info(f"月度报告已生成: {report_path}")
    return report_path

def main():
    """命令行入口"""
    parser = argparse.ArgumentParser(description='月度分析报告生成')
    parser.add_argument('--year', type=int, help='分析的年份（默认: 上月年份）')
    parser.add_argument('--month', type=int, help='分析的月份（默认: 上月月份）')
    parser.add_argument('--force', action='store_true', help='强制生成报告（即使没有数据）')
    
    args = parser.parse_args()
    
    # 确定分析的月份
    if args.year and args.month:
        year, month = args.year, args.month
    else:
        year, month = get_previous_month()
    
    logger.info(f"开始分析 {year}年{month}月 的日记记录")
    
    # 收集条目
    entries = collect_monthly_entries(year, month)
    
    if not entries and not args.force:
        logger.warning(f"{year}年{month}月没有找到日记条目，跳过分析")
        print(f"⚠️  {year}年{month}月没有日记记录，无需分析")
        sys.exit(0)
    
    # 分析条目
    analysis = analyze_entries(entries)
    
    # 生成报告
    report_path = generate_report(analysis, entries, year, month)
    
    print(f"✅ 月度分析报告生成完成！")
    print(f"📊 分析月份: {year}年{month}月")
    print(f"📝 记录数量: {analysis['total_entries']} 条")
    print(f"📄 报告文件: {report_path}")
    
    # 返回报告路径供其他脚本使用
    print(f"REPORT_PATH:{report_path}")

if __name__ == "__main__":
    main()