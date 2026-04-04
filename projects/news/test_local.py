#!/usr/bin/env python3
"""
本地測試腳本
用於在部署前測試各個模組
"""

import sys
import os

# 添加 scripts 目錄到路徑
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'scripts'))

import logging
from utils import get_taiwan_date
from rss_fetcher import fetch_all_rss_feeds
from news_filter import filter_and_score_news

# 設置日誌
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def test_date_generation():
    """測試日期生成"""
    logger.info("\n" + "="*50)
    logger.info("測試 1: 日期生成")
    logger.info("="*50)
    
    date = get_taiwan_date()
    logger.info(f"✅ 台灣時間日期: {date}")
    
    return date


def test_rss_fetching(date):
    """測試 RSS 讀取"""
    logger.info("\n" + "="*50)
    logger.info("測試 2: RSS 讀取")
    logger.info("="*50)
    
    feeds = fetch_all_rss_feeds(date)
    logger.info(f"✅ 成功讀取 {len(feeds)} 則新聞")
    
    # 顯示每個來源的數量
    from collections import Counter
    source_counts = Counter(feed.get('source', 'unknown') for feed in feeds)
    
    logger.info("\n來源分布:")
    for source, count in source_counts.most_common():
        logger.info(f"  - {source}: {count} 則")
    
    return feeds


def test_news_filtering(feeds, date):
    """測試新聞篩選"""
    logger.info("\n" + "="*50)
    logger.info("測試 3: 新聞篩選")
    logger.info("="*50)
    
    filtered = filter_and_score_news(feeds, date)
    logger.info(f"✅ 篩選後保留 {len(filtered)} 則新聞")
    
    # 顯示前 5 則新聞
    logger.info("\n分數最高的 5 則新聞:")
    for i, item in enumerate(filtered[:5], 1):
        logger.info(f"\n{i}. {item['title']}")
        logger.info(f"   來源: {item['source_label']}")
        logger.info(f"   分數: {item['relevance_score']}")
        logger.info(f"   連結: {item['link'][:80]}...")
    
    return filtered


def test_ai_processing(filtered, date):
    """測試 AI 處理（需要 API keys）"""
    logger.info("\n" + "="*50)
    logger.info("測試 4: AI 處理（需要 API Keys）")
    logger.info("="*50)
    
    # 檢查環境變數
    google_key = os.getenv('GOOGLE_API_KEY')
    openai_key = os.getenv('OPENAI_API_KEY')
    
    if not google_key or not openai_key:
        logger.warning("⚠️  未設置 API Keys，跳過 AI 測試")
        logger.info("設置方法:")
        logger.info("  export GOOGLE_API_KEY='your_key'")
        logger.info("  export OPENAI_API_KEY='your_key'")
        return None
    
    logger.info("✅ API Keys 已設置，開始測試...")
    
    try:
        from ai_processor import (
            process_with_data_alchemist,
            process_with_tech_narrator,
            process_with_editor_in_chief
        )
        from utils import validate_json_output
        
        # 為了測試，只使用前 10 則新聞
        test_filtered = filtered[:10]
        
        # 數據煉金術師
        logger.info("\n⚗️  測試數據煉金術師...")
        alchemist_output = process_with_data_alchemist(test_filtered, date)
        alchemist_json = validate_json_output(alchemist_output, "數據煉金術師")
        logger.info("✅ 數據煉金術師測試成功")
        
        # 科技導讀人
        logger.info("\n📰 測試科技導讀人...")
        narrator_output = process_with_tech_narrator(alchemist_json, date)
        narrator_json = validate_json_output(narrator_output, "科技導讀人")
        logger.info("✅ 科技導讀人測試成功")
        
        # 總編輯
        logger.info("\n✍️  測試總編輯...")
        editor_output = process_with_editor_in_chief(narrator_json, date)
        editor_json = validate_json_output(editor_output, "總編輯")
        logger.info("✅ 總編輯測試成功")
        
        return {
            'alchemist': alchemist_json,
            'narrator': narrator_json,
            'editor': editor_json
        }
        
    except Exception as e:
        logger.error(f"❌ AI 處理測試失敗: {str(e)}")
        return None


def main():
    """主測試流程"""
    logger.info("🚀 開始本地測試...")
    logger.info("="*50)
    
    try:
        # 測試 1: 日期生成
        date = test_date_generation()
        
        # 測試 2: RSS 讀取
        feeds = test_rss_fetching(date)
        
        if not feeds:
            logger.error("❌ 沒有讀取到新聞，測試終止")
            return 1
        
        # 測試 3: 新聞篩選
        filtered = test_news_filtering(feeds, date)
        
        if not filtered:
            logger.warning("⚠️  沒有新聞通過篩選")
            return 0
        
        # 測試 4: AI 處理（可選）
        ai_results = test_ai_processing(filtered, date)
        
        # 總結
        logger.info("\n" + "="*50)
        logger.info("測試總結")
        logger.info("="*50)
        logger.info("✅ 日期生成: 通過")
        logger.info("✅ RSS 讀取: 通過")
        logger.info("✅ 新聞篩選: 通過")
        
        if ai_results:
            logger.info("✅ AI 處理: 通過")
        else:
            logger.info("⚠️  AI 處理: 跳過（未設置 API Keys）")
        
        logger.info("\n🎉 本地測試完成！")
        logger.info("="*50)
        
        return 0
        
    except Exception as e:
        logger.error(f"\n❌ 測試過程發生錯誤: {str(e)}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
