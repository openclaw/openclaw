#!/usr/bin/env python3
"""
每日散步思考记录处理主脚本
自动化处理当天的录音文件
"""

import os
import sys
import argparse
from pathlib import Path
from datetime import datetime, timedelta
import subprocess

# 添加项目根目录到Python路径
project_root = Path(__file__).parent.parent
sys.path.append(str(project_root))

from utils.file_utils import ensure_dir, find_files_by_pattern
from utils.audio_utils import get_audio_duration

def find_today_audio_files(audio_dir, date_str=None):
    """
    查找今天的音频文件
    
    Args:
        audio_dir: 音频目录
        date_str: 日期字符串（如2026-02-04），如果为None则使用今天
        
    Returns:
        list: 音频文件路径列表
    """
    if date_str is None:
        date_str = datetime.now().strftime("%Y-%m-%d")
    
    # 查找以日期开头的文件
    audio_path = Path(audio_dir)
    pattern = f"{date_str}_*.mp3"
    
    files = list(audio_path.glob(pattern))
    
    # 如果没有找到，尝试查找今天修改的文件
    if not files:
        cutoff_time = datetime.now() - timedelta(hours=24)
        cutoff_timestamp = cutoff_time.timestamp()
        
        all_audio_files = find_files_by_pattern(audio_dir, "*.mp3", recursive=False)
        for file_path in all_audio_files:
            if file_path.stat().st_mtime > cutoff_timestamp:
                files.append(file_path)
    
    return files

def process_audio_file(audio_path, weather=None):
    """
    处理单个音频文件
    
    Args:
        audio_path: 音频文件路径
        weather: 天气信息
        
    Returns:
        dict: 处理结果
    """
    print(f"\n{'='*50}")
    print(f"处理音频文件: {audio_path.name}")
    print(f"{'='*50}")
    
    result = {
        "audio_file": str(audio_path),
        "success": False,
        "steps": {},
        "error": None
    }
    
    try:
        # 步骤1: 获取音频时长
        print("📏 获取音频时长...")
        duration = get_audio_duration(audio_path)
        result["steps"]["get_duration"] = {
            "success": True,
            "duration_seconds": duration
        }
        print(f"  时长: {duration:.1f}秒")
        
        # 步骤2: 转写音频
        print("🎤 转写音频...")
        transcribe_script = project_root / "scripts" / "transcribe.py"
        
        transcribe_cmd = [
            sys.executable, str(transcribe_script),
            str(audio_path)
        ]
        
        transcribe_result = subprocess.run(
            transcribe_cmd,
            capture_output=True,
            text=True,
            cwd=project_root
        )
        
        if transcribe_result.returncode != 0:
            raise Exception(f"转写失败: {transcribe_result.stderr}")
        
        # 从输出中提取转写文件路径
        output_lines = transcribe_result.stdout.split('\n')
        transcript_path = None
        for line in output_lines:
            if "输出文件:" in line:
                transcript_path = line.split("输出文件:")[1].strip()
                break
        
        if not transcript_path:
            # 尝试从默认位置获取
            audio_name = Path(audio_path).stem
            date_str = audio_name.split('_')[0]
            transcript_path = project_root / "data" / "transcripts" / f"{date_str}_raw.txt"
        
        result["steps"]["transcribe"] = {
            "success": True,
            "transcript_path": str(transcript_path),
            "output": transcribe_result.stdout[:500]  # 保存前500字符
        }
        print(f"✅ 转写完成: {transcript_path}")
        
        # 步骤3: Kimi分析
        print("🤖 Kimi分析...")
        analyze_script = project_root / "scripts" / "analyze_kimi.py"
        
        analyze_cmd = [
            sys.executable, str(analyze_script),
            str(transcript_path),
            "--audio-duration", str(int(duration)),
            "--weather", weather or "未记录"
        ]
        
        analyze_result = subprocess.run(
            analyze_cmd,
            capture_output=True,
            text=True,
            cwd=project_root
        )
        
        if analyze_result.returncode != 0:
            raise Exception(f"分析失败: {analyze_result.stderr}")
        
        # 从输出中提取Markdown文件路径
        output_lines = analyze_result.stdout.split('\n')
        markdown_path = None
        for line in output_lines:
            if "输出文件:" in line:
                markdown_path = line.split("输出文件:")[1].strip()
                break
        
        result["steps"]["analyze"] = {
            "success": True,
            "markdown_path": markdown_path,
            "output": analyze_result.stdout[:500]
        }
        
        print(f"✅ 分析完成: {markdown_path}")
        
        # 步骤4: 移动已处理的音频文件
        processed_audio_dir = project_root / "data" / "audio_processed"
        ensure_dir(processed_audio_dir)
        
        processed_audio_path = processed_audio_dir / audio_path.name
        audio_path.rename(processed_audio_path)
        
        result["steps"]["move_audio"] = {
            "success": True,
            "processed_path": str(processed_audio_path)
        }
        print(f"📦 音频文件已移动到: {processed_audio_path}")
        
        result["success"] = True
        result["final_output"] = markdown_path
        
        print(f"\n🎉 处理完成!")
        print(f"📄 最终输出: {markdown_path}")
        
    except Exception as e:
        result["success"] = False
        result["error"] = str(e)
        print(f"❌ 处理失败: {e}")
        import traceback
        traceback.print_exc()
    
    return result

def main():
    parser = argparse.ArgumentParser(description="每日散步思考记录处理")
    parser.add_argument("--date", help="处理指定日期（格式：YYYY-MM-DD）")
    parser.add_argument("--weather", default="未记录", help="天气情况")
    parser.add_argument("--audio-dir", default=None, help="音频目录（默认：data/audio/）")
    
    args = parser.parse_args()
    
    # 设置目录
    if args.audio_dir:
        audio_dir = Path(args.audio_dir)
    else:
        audio_dir = project_root / "data" / "audio"
    
    ensure_dir(audio_dir)
    
    # 查找音频文件
    print(f"🔍 在 {audio_dir} 中查找音频文件...")
    audio_files = find_today_audio_files(audio_dir, args.date)
    
    if not audio_files:
        print(f"❌ 未找到{'今天' if not args.date else args.date}的音频文件")
        print(f"📁 请将录音文件放到: {audio_dir}")
        print(f"📝 文件名格式: YYYY-MM-DD_描述.mp3 (如: 2026-02-04_散步思考.mp3)")
        sys.exit(1)
    
    print(f"📊 找到 {len(audio_files)} 个音频文件:")
    for i, file_path in enumerate(audio_files, 1):
        print(f"  {i}. {file_path.name}")
    
    # 处理每个文件
    results = []
    for audio_file in audio_files:
        result = process_audio_file(audio_file, args.weather)
        results.append(result)
    
    # 生成处理报告
    print(f"\n{'='*60}")
    print("处理报告")
    print(f"{'='*60}")
    
    successful = sum(1 for r in results if r["success"])
    failed = len(results) - successful
    
    print(f"📈 统计:")
    print(f"  ✅ 成功: {successful}")
    print(f"  ❌ 失败: {failed}")
    
    if successful > 0:
        print(f"\n📁 生成的文件:")
        for result in results:
            if result["success"] and "final_output" in result:
                print(f"  • {result['final_output']}")
    
    # 保存处理日志
    log_dir = project_root / "logs"
    ensure_dir(log_dir)
    
    log_file = log_dir / f"process_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    
    import json
    log_data = {
        "timestamp": datetime.now().isoformat(),
        "date_processed": args.date or datetime.now().strftime("%Y-%m-%d"),
        "weather": args.weather,
        "results": results,
        "summary": {
            "total": len(results),
            "successful": successful,
            "failed": failed
        }
    }
    
    with open(log_file, 'w', encoding='utf-8') as f:
        json.dump(log_data, f, ensure_ascii=False, indent=2)
    
    print(f"\n📋 详细日志已保存: {log_file}")
    
    # 如果有失败，返回非零退出码
    if failed > 0:
        sys.exit(1)

if __name__ == "__main__":
    main()