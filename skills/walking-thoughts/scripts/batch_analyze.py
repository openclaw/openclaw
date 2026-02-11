#!/usr/bin/env python3
"""
批量分析脚本：定期分析一段时间内的日记记录
例如：每月分析一次，生成总结报告
"""

import os
import sys
import json
import argparse
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict

# 添加项目根目录到Python路径
project_root = Path(__file__).parent.parent
sys.path.append(str(project_root))

from utils.file_utils import ensure_dir, save_text, load_text

def load_kimi_config():
    """加载Kimi配置"""
    config_path = project_root / "config" / "kimi_config.json"
    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def init_kimi_client(config):
    """初始化Kimi客户端"""
    from openai import OpenAI
    client = OpenAI(
        api_key=config["api_key"],
        base_url=config["base_url"],
        timeout=config.get("timeout", 30)
    )
    return client

def call_kimi_api(client, config, prompt, text, max_retries=3):
    """调用Kimi API"""
    for attempt in range(max_retries):
        try:
            response = client.chat.completions.create(
                model=config["model"],
                messages=[
                    {"role": "system", "content": "你是一个专业的思考记录分析助手，擅长整理和分析口语化的思考内容。"},
                    {"role": "user", "content": f"{prompt}\n\n以下是思考记录文本：\n\n{text}"}
                ],
                temperature=config["temperature"],
                max_tokens=config["max_tokens"]
            )
            
            content = response.choices[0].message.content
            print(f"✅ Kimi分析完成 (尝试 {attempt + 1})")
            return content.strip()
            
        except Exception as e:
            if attempt < max_retries - 1:
                delay = config.get("retry_delay", 2) * (attempt + 1)
                print(f"⚠️  请求失败，{delay}秒后重试... ({e})")
                import time
                time.sleep(delay)
            else:
                raise Exception(f"Kimi API调用失败: {e}")

def collect_transcripts(start_date, end_date):
    """收集指定日期范围内的转写文本"""
    transcripts_dir = project_root / "data" / "transcripts"
    
    if not transcripts_dir.exists():
        print(f"❌ 转写目录不存在: {transcripts_dir}")
        return []
    
    transcripts = []
    
    for file_path in transcripts_dir.glob("*.txt"):
        # 从文件名提取日期（假设格式: YYYY-MM-DD_* 或 file_raw.txt）
        filename = file_path.name
        
        if filename == "file_raw.txt" or filename == "file_with_timestamps.txt":
            # 这些是临时文件，跳过或使用文件修改时间
            file_date = datetime.fromtimestamp(file_path.stat().st_mtime).date()
        else:
            try:
                # 尝试从文件名解析日期
                date_part = filename[:10]  # YYYY-MM-DD
                file_date = datetime.strptime(date_part, "%Y-%m-%d").date()
            except:
                # 如果解析失败，使用文件修改时间
                file_date = datetime.fromtimestamp(file_path.stat().st_mtime).date()
        
        # 检查日期是否在范围内
        if start_date <= file_date <= end_date:
            try:
                content = load_text(file_path)
                transcripts.append({
                    'date': file_date,
                    'filename': filename,
                    'path': file_path,
                    'content': content,
                    'length': len(content)
                })
                print(f"📅 收集: {file_date} - {filename} ({len(content)}字符)")
            except Exception as e:
                print(f"❌ 读取失败 {filename}: {e}")
    
    # 按日期排序
    transcripts.sort(key=lambda x: x['date'])
    
    return transcripts

def generate_period_report(transcripts, start_date, end_date):
    """生成周期报告"""
    if not transcripts:
        return "## 📊 周期报告\n\n*该时间段内无记录*"
    
    # 合并所有文本
    all_text = "\n\n---\n\n".join([
        f"## {t['date']}\n\n{t['content']}"
        for t in transcripts
    ])
    
    total_chars = sum(t['length'] for t in transcripts)
    total_records = len(transcripts)
    
    report_header = f"""# {start_date} 至 {end_date} 思考记录分析报告

## 📈 统计概览
- **分析周期**: {start_date} 至 {end_date}
- **记录数量**: {total_records} 条
- **总文字量**: {total_chars} 字符
- **平均长度**: {total_chars // total_records if total_records > 0 else 0} 字符/条

## 📅 记录日期
{', '.join(sorted(set(str(t['date']) for t in transcripts)))}

---
"""
    
    return report_header + all_text

def analyze_with_kimi(client, config, report_text, period_name):
    """使用Kimi分析周期报告"""
    prompt = f"""请分析以下时间段内的思考记录，生成深度分析报告：

分析要求：
1. **主要关注点**：这段时间思考最多的是什么主题？
2. **情绪趋势**：整体情绪如何变化？
3. **瓶颈识别**：遇到了哪些困难或阻碍？
4. **成长发现**：有哪些新的认知或进步？
5. **具体建议**：基于分析给出3-5条具体建议
6. **模式识别**：发现什么重复出现的思考模式？

请用中文回复，使用Markdown格式，结构清晰。
"""
    
    print(f"🤖 使用Kimi分析{period_name}的记录...")
    analysis = call_kimi_api(client, config, prompt, report_text)
    
    return analysis

def main():
    parser = argparse.ArgumentParser(description="批量分析日记记录")
    parser.add_argument("--period", choices=["week", "month", "quarter", "custom"], 
                       default="month", help="分析周期")
    parser.add_argument("--start-date", help="开始日期 (YYYY-MM-DD)")
    parser.add_argument("--end-date", help="结束日期 (YYYY-MM-DD)")
    parser.add_argument("--output-dir", help="输出目录")
    args = parser.parse_args()
    
    # 确定日期范围
    today = datetime.now().date()
    
    if args.period == "week":
        start_date = today - timedelta(days=7)
        end_date = today
        period_name = "本周"
    elif args.period == "month":
        start_date = today.replace(day=1)  # 本月第一天
        end_date = today
        period_name = "本月"
    elif args.period == "quarter":
        # 简化：最近90天
        start_date = today - timedelta(days=90)
        end_date = today
        period_name = "本季度"
    elif args.period == "custom" and args.start_date and args.end_date:
        start_date = datetime.strptime(args.start_date, "%Y-%m-%d").date()
        end_date = datetime.strptime(args.end_date, "%Y-%m-%d").date()
        period_name = f"{args.start_date}至{args.end_date}"
    else:
        print("❌ 请提供有效的日期范围")
        sys.exit(1)
    
    print(f"📊 分析周期: {start_date} 至 {end_date} ({period_name})")
    
    # 收集转写文本
    transcripts = collect_transcripts(start_date, end_date)
    
    if not transcripts:
        print("📭 该时间段内无记录")
        sys.exit(0)
    
    print(f"✅ 收集到 {len(transcripts)} 条记录")
    
    # 设置输出目录
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        output_dir = project_root / "data" / "periodic_analysis"
    ensure_dir(output_dir)
    
    # 生成基础报告
    print("📄 生成基础报告...")
    base_report = generate_period_report(transcripts, start_date, end_date)
    
    base_report_path = output_dir / f"report_{start_date}_to_{end_date}_base.md"
    save_text(base_report_path, base_report)
    print(f"✅ 基础报告已保存: {base_report_path}")
    
    # 使用Kimi进行深度分析
    try:
        config = load_kimi_config()
        client = init_kimi_client(config)
        
        kimi_analysis = analyze_with_kimi(client, config, base_report, period_name)
        
        # 合并报告
        full_report = f"""{base_report}

---

## 🧠 Kimi深度分析报告

{kimi_analysis}

---

*分析时间: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}*
*使用散步思考记录系统 + Kimi 2.5批量分析*
"""
        
        full_report_path = output_dir / f"report_{start_date}_to_{end_date}_full.md"
        save_text(full_report_path, full_report)
        
        print(f"\n🎉 批量分析完成!")
        print(f"📁 基础报告: {base_report_path}")
        print(f"📁 完整报告: {full_report_path}")
        
        # 预览分析结果
        print("\n📋 Kimi分析预览:")
        preview_lines = kimi_analysis.split('\n')[:10]
        for line in preview_lines:
            print(line)
        
    except Exception as e:
        print(f"⚠️  Kimi分析失败: {e}")
        print("✅ 基础报告已保存，可手动分析")

if __name__ == "__main__":
    main()