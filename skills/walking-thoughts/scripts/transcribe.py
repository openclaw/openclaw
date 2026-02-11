#!/usr/bin/env python3
"""
语音转录脚本 - 使用Whisper进行语音转文字
"""

import os
import sys
import argparse
from pathlib import Path

def transcribe_with_whisper(audio_path, output_path=None):
    """
    使用Whisper转录音频文件
    
    Args:
        audio_path: 音频文件路径
        output_path: 输出文件路径（可选）
    
    Returns:
        str: 转录文本
    """
    try:
        import whisper
        
        # 加载模型
        model = whisper.load_model("base")
        
        # 转录音频
        result = model.transcribe(
            str(audio_path),
            language='zh',
            fp16=False  # CPU模式
        )
        
        transcript = result['text'].strip()
        
        # 保存到文件
        if output_path:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(transcript)
            print(f"原始转写已保存: {output_path}")
        
        return transcript
        
    except ImportError:
        print("❌ 错误: 未安装whisper库，请运行: pip install openai-whisper")
        return None
    except Exception as e:
        print(f"❌ 转录失败: {str(e)}")
        return None

def main():
    """命令行入口"""
    parser = argparse.ArgumentParser(description='语音转录脚本')
    parser.add_argument('audio_path', help='音频文件路径')
    parser.add_argument('output_path', nargs='?', help='输出文件路径（可选）')
    
    args = parser.parse_args()
    
    # 验证文件存在
    if not Path(args.audio_path).exists():
        print(f"❌ 错误: 文件不存在: {args.audio_path}")
        sys.exit(1)
    
    # 转录
    print(f"开始转录: {args.audio_path}")
    transcript = transcribe_with_whisper(args.audio_path, args.output_path)
    
    if transcript:
        print("\n📝 转录结果:")
        print("-" * 50)
        print(transcript)
        print("-" * 50)
        sys.exit(0)
    else:
        print("❌ 转录失败")
        sys.exit(1)

if __name__ == "__main__":
    main()