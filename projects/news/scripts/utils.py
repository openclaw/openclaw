"""
工具函數模組
"""

import json
import logging
import re
from datetime import datetime, timedelta
from typing import Dict
from json_repair import repair_json

logger = logging.getLogger(__name__)


def get_taiwan_date() -> str:
    """
    獲取台灣時間的日期 (UTC+8)
    
    Returns:
        日期字符串 (YYYY-MM-DD)
    """
    # 獲取當前 UTC 時間
    now = datetime.utcnow()
    
    # 加上 8 小時轉換為台灣時間
    taiwan_time = now + timedelta(hours=8)
    
    # 格式化為 YYYY-MM-DD
    date_string = taiwan_time.strftime('%Y-%m-%d')
    
    return date_string


def validate_json_output(raw_output: str, agent_name: str) -> Dict:
    """
    驗證和清理 AI 輸出的 JSON
    增強版：包含自動修復功能

    Args:
        raw_output: AI 的原始輸出
        agent_name: Agent 名稱（用於日誌）

    Returns:
        解析後的 JSON 對象
    """
    logger.info(f"🔧 驗證 {agent_name} 的輸出...")

    try:
        # 嘗試找到 JSON 對象的邊界
        start_index = raw_output.find('{')
        end_index = raw_output.rfind('}')

        if start_index == -1 or end_index == -1:
            raise ValueError(f"無法在輸出中找到 JSON 對象")

        # 提取 JSON 字符串
        json_string = raw_output[start_index:end_index + 1]

        # 清理可能的 markdown 代碼塊標記
        json_string = json_string.replace('```json', '').replace('```', '').strip()

        # 第一次嘗試：直接解析
        try:
            parsed_json = json.loads(json_string)
            logger.info(f"✅ {agent_name} 輸出驗證成功（直接解析）")
            return parsed_json
        except json.JSONDecodeError as e:
            logger.warning(f"⚠️  {agent_name} JSON 直接解析失敗: {str(e)}")
            logger.info(f"🔧 嘗試使用 json-repair 修復...")

            # 第二次嘗試：使用 json-repair
            try:
                repaired_string = repair_json(json_string)
                parsed_json = json.loads(repaired_string)
                logger.info(f"✅ {agent_name} 輸出驗證成功（使用修復）")
                return parsed_json
            except Exception as repair_error:
                logger.error(f"❌ {agent_name} JSON 修復也失敗: {str(repair_error)}")
                logger.error(f"原始輸出前 500 字: {raw_output[:500]}...")
                logger.error(f"JSON 字符串前 500 字: {json_string[:500]}...")
                raise ValueError(f"JSON 解析和修復都失敗: {str(e)}")

    except Exception as e:
        logger.error(f"❌ {agent_name} 輸出驗證失敗: {str(e)}")
        raise


def clean_json_string(json_str: str) -> str:
    """
    清理 JSON 字符串
    
    Args:
        json_str: 原始 JSON 字符串
        
    Returns:
        清理後的 JSON 字符串
    """
    # 移除 markdown 代碼塊標記
    json_str = re.sub(r'```json\s*', '', json_str)
    json_str = re.sub(r'```\s*', '', json_str)
    
    # 移除前後空白
    json_str = json_str.strip()
    
    return json_str


def format_date_chinese(date_str: str) -> str:
    """
    將日期格式化為中文
    
    Args:
        date_str: 日期字符串 (YYYY-MM-DD)
        
    Returns:
        中文日期字符串 (YYYY年MM月DD日)
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        return dt.strftime('%Y年%m月%d日')
    except:
        return date_str


def truncate_text(text: str, max_length: int = 200) -> str:
    """
    截斷文本到指定長度
    
    Args:
        text: 原始文本
        max_length: 最大長度
        
    Returns:
        截斷後的文本
    """
    if len(text) <= max_length:
        return text
    
    return text[:max_length] + '...'


def safe_get(d: dict, *keys, default=None):
    """
    安全地獲取嵌套字典的值
    
    Args:
        d: 字典
        *keys: 鍵路徑
        default: 默認值
        
    Returns:
        值或默認值
    """
    for key in keys:
        try:
            d = d[key]
        except (KeyError, TypeError):
            return default
    return d
