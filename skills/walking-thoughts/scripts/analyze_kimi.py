#!/usr/bin/env python3
"""
使用Kimi 2.5分析思考记录
包括：整理文本、提取洞察、生成结构化内容
"""

import os
import sys
import json
import argparse
from pathlib import Path
from datetime import datetime
from openai import OpenAI

# 添加项目根目录到Python路径
project_root = Path(__file__).parent.parent
sys.path.append(str(project_root))

from utils.file_utils import ensure_dir, save_text, load_text

def load_env():
    """Load .env file"""
    env_path = project_root.parent.parent / ".env"
    if env_path.exists():
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                if '=' in line and not line.strip().startswith('#'):
                    key, value = line.strip().split('=', 1)
                    if key.startswith('export '):
                        key = key[7:].strip()
                    if key and value and key not in os.environ:
                        os.environ[key] = value.strip()

def load_kimi_config():
    """加载Kimi配置"""
    load_env()
    config_path = project_root / "config" / "kimi_config.json"
    
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
        
    # Resolve API keys from env
    if config.get("api_key") in ["MOONSHOT_API_KEY", "MONTHSHOT_API_KEY"]:
        config["api_key"] = os.environ.get("MOONSHOT_API_KEY", config["api_key"])
        
    if config.get("search_api_key") == "OPENROUTER_API_KEY":
        config["search_api_key"] = os.environ.get("OPENROUTER_API_KEY", config["search_api_key"])
        
    return config

def init_kimi_client(config):
    """初始化Kimi客户端"""
    client = OpenAI(
        api_key=config["api_key"],
        base_url=config["base_url"],
        timeout=config.get("timeout", 30)
    )
    return client

def call_kimi_api(client, config, prompt, text, max_retries=3):
    """
    调用Kimi API
    
    Args:
        client: OpenAI客户端
        config: Kimi配置
        prompt: 提示词
        text: 待处理文本
        max_retries: 最大重试次数
        
    Returns:
        str: API响应内容
    """
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

def clean_and_organize_text(client, config, raw_text):
    """
    清理和整理原始转写文本
    
    Args:
        client: Kimi客户端
        config: 配置
        raw_text: 原始转写文本
        
    Returns:
        str: 整理后的文本
    """
    print("🧹 清理和整理文本...")
    prompt = config["analysis_prompts"]["clean_and_organize"]
    return call_kimi_api(client, config, prompt, raw_text)

def extract_insights(client, config, organized_text):
    """
    从整理后的文本中提取洞察
    
    Args:
        client: Kimi客户端
        config: 配置
        organized_text: 整理后的文本
        
    Returns:
        str: 洞察分析结果
    """
    print("🔍 提取洞察和分析...")
    prompt = config["analysis_prompts"]["extract_insights"]
    return call_kimi_api(client, config, prompt, organized_text)

def create_daily_record(date_str, organized_text, insights_text, audio_duration=None, weather=None):
    """
    创建每日记录Markdown文件
    
    Args:
        date_str: 日期字符串
        organized_text: 整理后的文本
        insights_text: 洞察分析
        audio_duration: 音频时长（秒）
        weather: 天气信息
        
    Returns:
        str: Markdown内容
    """
    # 解析日期
    try:
        date_obj = datetime.strptime(date_str, "%Y-%m-%d")
        weekday = date_obj.strftime("%A")
        chinese_weekday = {
            "Monday": "星期一", "Tuesday": "星期二", "Wednesday": "星期三",
            "Thursday": "星期四", "Friday": "星期五", "Saturday": "星期六",
            "Sunday": "星期日"
        }.get(weekday, weekday)
    except:
        chinese_weekday = ""
    
    # 构建Markdown
    markdown = f"""# {date_str} 散步思考记录 {chinese_weekday}

## 📅 基本信息
- **记录时间**: {datetime.now().strftime("%Y-%m-%d %H:%M")}
- **思考时长**: {audio_duration or "未知"}秒
- **天气情况**: {weather or "未记录"}

## 🎯 核心思考

{organized_text}

## 🔍 分析结果

{insights_text}

## 💭 原始记录链接
- [原始转写文本](./../transcripts/{date_str}_raw.txt)
- [整理前预览](./../transcripts/{date_str}_preview.txt)

---

*记录于 {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}*
*使用散步思考记录系统 + Kimi 2.5分析*
"""
    
    return markdown

def main():
    parser = argparse.ArgumentParser(description="使用Kimi 2.5分析思考记录")
    parser.add_argument("input_path", help="输入文件路径（原始转写文本）")
    parser.add_argument("--output-dir", default=None, help="输出目录（默认：data/processed/）")
    parser.add_argument("--audio-duration", type=int, help="音频时长（秒）")
    parser.add_argument("--weather", default="未记录", help="天气情况")
    
    args = parser.parse_args()
    
    # 检查输入文件
    input_path = Path(args.input_path)
    if not input_path.exists():
        print(f"❌ 文件不存在: {input_path}")
        sys.exit(1)
    
    # 从文件名提取日期
    date_str = input_path.stem.split('_')[0]
    
    # 设置输出目录
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        output_dir = project_root / "data" / "processed"
    ensure_dir(output_dir)
    
    # 加载配置
    config = load_kimi_config()
    
    try:
        # 初始化Kimi客户端
        print("🔗 连接Kimi 2.5 API...")
        client = init_kimi_client(config)
        
        # 读取原始文本
        print(f"📖 读取文件: {input_path}")
        raw_text = load_text(input_path)
        print(f"📝 原始文本长度: {len(raw_text)}字符")
        
        # 步骤1: 清理和整理文本
        organized_text = clean_and_organize_text(client, config, raw_text)
        
        # 保存整理后的文本
        organized_path = output_dir.parent / "transcripts" / f"{date_str}_organized.txt"
        ensure_dir(organized_path.parent)
        save_text(organized_path, organized_text)
        print(f"📄 整理后文本已保存: {organized_path}")
        
        # 步骤2: 提取洞察
        insights_text = extract_insights(client, config, organized_text)
        
        # 保存洞察结果
        insights_path = output_dir.parent / "analysis" / f"{date_str}_insights.txt"
        ensure_dir(insights_path.parent)
        save_text(insights_path, insights_text)
        print(f"📊 洞察分析已保存: {insights_path}")
        
        # 步骤3: 创建每日记录
        markdown_content = create_daily_record(
            date_str, organized_text, insights_text,
            args.audio_duration, args.weather
        )
        
        # 保存Markdown文件
        markdown_path = output_dir / f"{date_str}.md"
        save_text(markdown_path, markdown_content)
        
        print(f"\n🎉 分析完成!")
        print(f"📅 日期: {date_str}")
        print(f"📁 输出文件: {markdown_path}")
        
        # 显示预览
        print(f"\n📋 生成内容预览:")
        lines = markdown_content.split('\n')[:15]
        print('\n'.join(lines))
        if len(markdown_content.split('\n')) > 15:
            print("...")
        
        return str(markdown_path)
        
    except Exception as e:
        print(f"❌ 分析失败: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
