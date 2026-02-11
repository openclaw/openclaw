#!/usr/bin/env python3
"""
散步思考记录系统 - 主自动化脚本
OpenClaw调用此脚本来处理语音消息
"""

import os
import sys
import json
import argparse
import logging
from pathlib import Path
from datetime import datetime
import subprocess

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
        logging.FileHandler(log_dir / "process.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

def load_config():
    """加载配置文件"""
    config_path = project_root / "config" / "openclaw_config.json"
    if config_path.exists():
        with open(config_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {
        "whisper_model": "base",
        "enable_deep_analysis": False,
        "archive_original": True
    }

def process_audio_file(audio_path, source_info=None):
    """
    处理音频文件的主函数
    
    Args:
        audio_path: 音频文件路径
        source_info: 来源信息字典，包含：
            - timestamp: 时间戳
            - source: 来源（telegram等）
            - user_id: 用户ID（可选）
            - message_id: 消息ID（可选）
    """
    logger.info(f"开始处理音频文件: {audio_path}")
    
    # 验证文件存在
    if not Path(audio_path).exists():
        logger.error(f"音频文件不存在: {audio_path}")
        return False, "音频文件不存在"
    
    # 生成时间戳
    if source_info and 'timestamp' in source_info:
        timestamp = source_info['timestamp']
    else:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    
    # 1. 转录语音
    logger.info("开始语音转录...")
    transcript_path = transcribe_audio(audio_path, timestamp)
    if not transcript_path:
        logger.error("语音转录失败")
        return False, "语音转录失败"
    
    # 2. 基础处理（创建日记条目）
    logger.info("创建基础日记条目...")
    entry_path = create_basic_entry(transcript_path, audio_path, timestamp, source_info)
    if not entry_path:
        logger.error("创建日记条目失败")
        return False, "创建日记条目失败"
    
    # 3. 归档原始文件（可选）
    config = load_config()
    if config.get("archive_original", True):
        archive_original(audio_path, timestamp)
    
    # 4. 深度分析（可选）
    if config.get("enable_deep_analysis", False):
        logger.info("开始深度分析...")
        analyze_path = deep_analyze(entry_path, timestamp)
        if analyze_path:
            logger.info(f"深度分析完成: {analyze_path}")
    
    logger.info(f"处理完成！日记条目: {entry_path}")
    return True, entry_path

def transcribe_audio(audio_path, timestamp):
    """调用转录脚本"""
    try:
        transcribe_script = project_root / "scripts" / "transcribe.py"
        
        # 创建输出目录
        transcripts_dir = project_root / "data" / "transcripts"
        transcripts_dir.mkdir(exist_ok=True)
        output_path = transcripts_dir / f"{timestamp}_raw.txt"
        
        # 调用转录脚本
        result = subprocess.run(
            [sys.executable, str(transcribe_script), str(audio_path), str(output_path)],
            capture_output=True,
            text=True,
            timeout=300  # 5分钟超时
        )
        
        if result.returncode == 0:
            logger.info(f"转录完成: {output_path}")
            return output_path
        else:
            logger.error(f"转录失败: {result.stderr}")
            return None
            
    except Exception as e:
        logger.error(f"转录过程出错: {str(e)}")
        return None

def create_basic_entry(transcript_path, audio_path, timestamp, source_info):
    """创建基础日记条目"""
    try:
        # 读取转录文本
        with open(transcript_path, 'r', encoding='utf-8') as f:
            transcript = f.read().strip()
        
        if not transcript:
            logger.warning("转录文本为空")
            transcript = "[无转录内容]"
        
        # 创建条目目录
        entries_dir = project_root / "data" / "entries"
        entries_dir.mkdir(exist_ok=True)
        
        # 生成文件名
        audio_filename = Path(audio_path).name
        entry_filename = f"{timestamp}_{audio_filename}.md"
        entry_path = entries_dir / entry_filename
        
        # 构建条目内容
        entry_content = f"""# 语音日记 - {timestamp}

## 📅 基本信息
- **记录时间**: {timestamp.replace('_', ' ')}
- **音频文件**: {audio_filename}
- **处理时间**: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
"""
        
        # 添加来源信息
        if source_info:
            entry_content += f"- **来源**: {source_info.get('source', '未知')}\n"
            if source_info.get('user_id'):
                entry_content += f"- **用户ID**: {source_info['user_id']}\n"
            if source_info.get('message_id'):
                entry_content += f"- **消息ID**: {source_info['message_id']}\n"
        
        entry_content += f"""
## 🎤 转录内容

{transcript}

## 📝 后续处理
*此记录已保存原始转写文本，可在定期分析时进行深度处理*

---

**文件信息**:
- 原始音频: `data/incoming/{audio_filename}`
- 转写文本: `data/transcripts/{Path(transcript_path).name}`
- 日记条目: `data/entries/{entry_filename}`

*使用散步思考记录系统（自动化模式）*
*"先记录，后分析"*
"""
        
        # 写入文件
        with open(entry_path, 'w', encoding='utf-8') as f:
            f.write(entry_content)
        
        logger.info(f"日记条目创建完成: {entry_path}")
        return entry_path
        
    except Exception as e:
        logger.error(f"创建日记条目出错: {str(e)}")
        return None

def archive_original(audio_path, timestamp):
    """归档原始音频文件"""
    try:
        archive_dir = project_root / "data" / "archive" / "audio"
        archive_dir.mkdir(parents=True, exist_ok=True)
        
        audio_filename = Path(audio_path).name
        archive_path = archive_dir / f"{timestamp}_{audio_filename}"
        
        import shutil
        shutil.copy2(audio_path, archive_path)
        logger.info(f"原始音频已归档: {archive_path}")
        
    except Exception as e:
        logger.error(f"归档原始音频出错: {str(e)}")

def deep_analyze(entry_path, timestamp):
    """深度分析（调用Kimi AI）"""
    try:
        # 这里可以调用深度分析脚本
        # 暂时返回None，表示不进行深度分析
        return None
    except Exception as e:
        logger.error(f"深度分析出错: {str(e)}")
        return None

def main():
    """命令行入口"""
    parser = argparse.ArgumentParser(description='散步思考记录系统 - 自动化处理器')
    parser.add_argument('audio_path', help='音频文件路径')
    parser.add_argument('--source', default='telegram', help='来源（默认: telegram）')
    parser.add_argument('--user-id', help='用户ID')
    parser.add_argument('--message-id', help='消息ID')
    parser.add_argument('--timestamp', help='时间戳（格式: YYYY-MM-DD_HHMMSS）')
    
    args = parser.parse_args()
    
    # 构建来源信息
    source_info = {
        'source': args.source,
        'timestamp': args.timestamp or datetime.now().strftime("%Y-%m-%d_%H%M%S")
    }
    
    if args.user_id:
        source_info['user_id'] = args.user_id
    if args.message_id:
        source_info['message_id'] = args.message_id
    
    # 处理音频文件
    success, result = process_audio_file(args.audio_path, source_info)
    
    if success:
        print(f"✅ 处理成功！日记条目: {result}")
        sys.exit(0)
    else:
        print(f"❌ 处理失败: {result}")
        sys.exit(1)

if __name__ == "__main__":
    main()