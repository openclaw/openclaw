#!/usr/bin/env python3
"""
基础处理脚本：只转写语音，不进行深度分析
用于日常语音日记的快速处理
"""

import os
import sys
import argparse
from pathlib import Path
from datetime import datetime

# 添加项目根目录到Python路径
project_root = Path(__file__).parent.parent
sys.path.append(str(project_root))

from utils.file_utils import ensure_dir, save_text

def transcribe_audio(audio_path):
    """调用转写脚本"""
    transcribe_script = project_root / "scripts" / "transcribe.py"
    
    import subprocess
    result = subprocess.run(
        [sys.executable, str(transcribe_script), str(audio_path)],
        capture_output=True,
        text=True
    )
    
    if result.returncode != 0:
        print(f"❌ 转写失败: {result.stderr}")
        return None
    
    # 从输出中提取转写文件路径
    output = result.stdout
    for line in output.split('\n'):
        if "原始转写已保存" in line:
            # 提取文件路径
            import re
            match = re.search(r':\s*(.+)$', line)
            if match:
                return match.group(1).strip()
    
    return None

def create_basic_entry(transcript_path, audio_filename):
    """创建基础日记条目（无深度分析）"""
    # 读取转写文本
    with open(transcript_path, 'r', encoding='utf-8') as f:
        transcript = f.read()
    
    # 从音频文件名提取日期
    # 格式: YYYY-MM-DD_描述.ogg
    date_str = audio_filename[:10]  # 前10个字符是日期
    
    # 获取当前日期和时间
    now = datetime.now()
    current_date = now.strftime("%Y-%m-%d")
    current_time = now.strftime("%H:%M")
    
    # 如果音频文件名没有日期，使用当前日期
    if not date_str.replace('-', '').isdigit():
        date_str = current_date
    
    # 创建基础日记内容
    content = f"""# {date_str} 语音日记记录

## 📅 基本信息
- **记录时间**: {current_date} {current_time}
- **音频文件**: {audio_filename}
- **处理时间**: {now.strftime("%Y-%m-%d %H:%M:%S")}

## 🎤 转写内容

{transcript}

## 📝 后续处理
*此记录已保存原始转写文本，可在定期分析时进行深度处理*

---

**文件信息**:
- 原始音频: `data/audio/{audio_filename}`
- 转写文本: `data/transcripts/{Path(transcript_path).name}`
- 处理时间: {now.strftime("%Y-%m-%d %H:%M:%S")}

*使用散步思考记录系统（基础模式）*
*"先记录，后分析"*
"""
    
    return content, date_str

def main():
    parser = argparse.ArgumentParser(description="基础语音日记处理（只转写，不分析）")
    parser.add_argument("audio_path", help="音频文件路径")
    parser.add_argument("--output-dir", help="输出目录（默认：data/processed_basic/）")
    args = parser.parse_args()
    
    audio_path = Path(args.audio_path)
    if not audio_path.exists():
        print(f"❌ 音频文件不存在: {audio_path}")
        sys.exit(1)
    
    # 设置输出目录
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        output_dir = project_root / "data" / "processed_basic"
    ensure_dir(output_dir)
    
    print(f"🎤 开始处理: {audio_path.name}")
    
    # 步骤1: 转写音频
    print("📝 转写音频...")
    transcript_path = transcribe_audio(audio_path)
    
    if not transcript_path or not Path(transcript_path).exists():
        print("❌ 转写失败")
        sys.exit(1)
    
    print(f"✅ 转写完成: {transcript_path}")
    
    # 步骤2: 创建基础日记条目
    print("📄 创建基础日记条目...")
    content, date_str = create_basic_entry(transcript_path, audio_path.name)
    
    # 步骤3: 保存日记文件
    markdown_path = output_dir / f"{date_str}_{audio_path.stem}.md"
    save_text(markdown_path, content)
    
    print(f"\n🎉 基础处理完成!")
    print(f"📅 日期: {date_str}")
    print(f"📁 输出文件: {markdown_path}")
    print(f"📝 转写文本: {transcript_path}")
    print(f"🔊 原始音频: {audio_path}")
    
    # 预览内容
    print("\n📋 内容预览:")
    preview_lines = content.split('\n')[:15]
    for line in preview_lines:
        print(line)

if __name__ == "__main__":
    main()