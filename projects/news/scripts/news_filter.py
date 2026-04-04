"""
台灣本地化新聞篩選器
移植自 n8n workflow 的 Code3 節點

核心功能：
1. 智能評分系統
2. 台灣視角優先
3. 來源平衡策略
"""

import logging
from datetime import datetime, timedelta
from typing import List, Dict
import re

logger = logging.getLogger(__name__)

# ============================================
# 篩選配置（與 n8n Code3 完全一致）
# ============================================

FILTERS = {
    'sources': {
        # === 台灣本地來源 ===
        'technews': {
            'priority_keywords': [
                # AI 相關
                'AI', '人工智慧', 'ChatGPT', 'Claude', 'Gemini',
                '生成式', 'LLM', '大型語言模型',
                # 台灣關鍵字
                '台積電', 'TSMC', '聯發科', '鴻海', '華碩', '宏碁',
                '台灣', 'Taiwan', '數位發展部', '資策會',
                # 實用工具
                '工具', 'App', '應用程式', '開源', '免費'
            ],
            'exclude': [
                '股價', '財報', '營收', '法說會',
                '併購', '投資', '基金'
            ],
            'max_items': 12,
            'base_score': 8
        },
        
        'ithome': {
            'priority_keywords': [
                'AI', '資安', 'Cloud', '雲端', 'DevOps',
                '開發', 'Python', 'JavaScript', 'API',
                '微軟', 'Google', 'AWS', 'Azure',
                '企業應用', '數位轉型', '自動化'
            ],
            'exclude': [
                '研討會', '論壇', '招標', '採購'
            ],
            'max_items': 10,
            'base_score': 7
        },
        
        'inside': {
            'priority_keywords': [
                'startup', '新創', 'AI', '創新', 'Web3',
                'NFT', '區塊鏈', 'Fintech', '金融科技',
                '電商', 'SaaS', 'B2B', 'B2C',
                '使用者體驗', 'UX', '產品設計'
            ],
            'exclude': [
                '募資', '種子輪', 'Series', 'IPO'
            ],
            'max_items': 8,
            'base_score': 6
        },
        
        # === 國際來源 ===
        'hackernews': {
            'priority_keywords': [
                'AI', 'ChatGPT', 'Claude', 'Gemini', 'OpenAI',
                'tool', 'app', 'browser', 'Python', 'npm'
            ],
            'exclude': [
                'CVE-2025', 'CVSS', 'vulnerability', 'ransomware'
            ],
            'max_items': 8,
            'base_score': 0
        },
        
        'techcrunch': {
            'priority_keywords': [
                'AI', 'ChatGPT', 'OpenAI', 'Anthropic',
                'app', 'tool', 'feature', 'launch'
            ],
            'exclude': [
                'raises', 'funding', 'valuation', 'layoffs'
            ],
            'max_items': 6,
            'base_score': 0
        },
        
        'openai': {
            'priority_keywords': ['GPT', 'API', 'model', 'release'],
            'exclude': [],
            'max_items': 5,
            'base_score': 15
        },
        
        'arstechnica': {
            'priority_keywords': [
                'AI', 'science', 'research', 'quantum', 'space'
            ],
            'exclude': ['gaming', 'review', 'streaming'],
            'max_items': 4,
            'base_score': 0
        },
        
        'bair': {
            'priority_keywords': ['research', 'paper', 'algorithm'],
            'exclude': [],
            'max_items': 3,
            'base_score': 3
        }
    },
    
    # 台灣民眾特別關注的關鍵字
    'taiwan_interests': [
        # 本土企業與產業
        '半導體', '晶片', '晶圓', 'IC設計', '封測',
        '電動車', '儲能', '綠能', '太陽能', '風電',
        
        # 台灣相關國際新聞
        'Taiwan', '台灣', 'Taipei', '台北',
        'Asia', '亞洲', '東南亞', 'ASEAN',
        
        # 實用性高的內容
        '教學', '懶人包', '比較', '推薦', '免費',
        '中文', '繁體', '在地化', '本土化',
        
        # 熱門應用
        'LINE', 'Instagram', 'YouTube', '抖音', 'TikTok',
        '街口', 'PChome', '蝦皮', 'momo'
    ],
    
    # 全球趨勢但台灣特別關注
    'global_taiwan_focus': [
        'NVIDIA', 'AMD', 'Intel',
        'Apple', 'iPhone',
        '供應鏈', 'supply chain',
        '中美', 'US-China', '晶片戰'
    ],
    
    'must_keep_phrases': [
        '台積電', 'TSMC',
        '數位發展部',
        'ChatGPT 開放台灣',
        'Google 台灣',
        'Microsoft 台灣'
    ]
}

# 來源中文標籤
SOURCE_LABELS = {
    'technews': '🇹🇼 科技新報',
    'ithome': '🇹🇼 iThome',
    'inside': '🇹🇼 INSIDE',
    'hackernews': '🌍 Hacker News',
    'techcrunch': '🌍 TechCrunch',
    'arstechnica': '🌍 Ars Technica',
    'openai': '🤖 OpenAI',
    'bair': '🎓 Berkeley AI'
}


def calculate_relevance(item: Dict) -> int:
    """
    計算新聞的相關性分數
    
    Args:
        item: 新聞項目
        
    Returns:
        相關性分數
    """
    title = item.get('title', '').lower()
    content = item.get('content', '').lower()
    link = item.get('link', '')
    full_text = f"{title} {content}"
    
    source = item.get('source', 'unknown')
    config = FILTERS['sources'].get(source, {
        'priority_keywords': [],
        'exclude': [],
        'base_score': 0
    })
    
    score = config.get('base_score', 0)
    
    # 1. 必須保留
    for phrase in FILTERS['must_keep_phrases']:
        if phrase.lower() in full_text:
            return 100
    
    # 2. 排除關鍵字
    for keyword in config.get('exclude', []):
        if keyword.lower() in full_text:
            score -= 5
    
    # 3. 來源優先關鍵字
    for keyword in config.get('priority_keywords', []):
        keyword_lower = keyword.lower()
        if keyword_lower in title:
            score += 10
        elif keyword_lower in content:
            score += 5
    
    # 4. 台灣興趣關鍵字（額外加分）
    for keyword in FILTERS['taiwan_interests']:
        if keyword.lower() in full_text:
            score += 4
    
    # 5. 全球但台灣關注的主題
    for keyword in FILTERS['global_taiwan_focus']:
        if keyword.lower() in full_text:
            score += 6
    
    # 6. 特殊處理
    is_taiwan_source = source in ['technews', 'ithome', 'inside']
    is_international_source = source in ['hackernews', 'techcrunch', 'openai']
    
    if is_taiwan_source:
        score += 5
        if '國際' in full_text or 'global' in full_text:
            score += 8
    
    if is_international_source:
        if 'taiwan' in full_text or 'asia' in full_text:
            score += 10
    
    # 7. 實用性加分
    practical_keywords = ['教學', 'tutorial', 'guide', '實測', '評測', '比較']
    for keyword in practical_keywords:
        if keyword in title:
            score += 7
    
    # 8. 內容長度
    if len(content) > 300:
        score += 2
    if len(content) > 500:
        score += 2
    
    return score


def filter_and_score_news(all_news: List[Dict], target_date: str) -> List[Dict]:
    """
    篩選和評分新聞
    
    Args:
        all_news: 所有新聞列表
        target_date: 目標日期
        
    Returns:
        篩選後的新聞列表
    """
    logger.info("🔍 開始篩選新聞...")
    
    # 解析目標日期
    target_dt = datetime.strptime(target_date, '%Y-%m-%d')
    yesterday = target_dt - timedelta(days=1)
    yesterday_str = yesterday.strftime('%Y-%m-%d')
    
    # 分組處理
    grouped = {source: [] for source in FILTERS['sources'].keys()}
    grouped['unknown'] = []
    
    for item in all_news:
        # 檢查日期
        pub_date = item.get('isoDate', '')
        if pub_date:
            try:
                pub_dt = datetime.fromisoformat(pub_date.replace('Z', '+00:00'))
                if pub_dt.strftime('%Y-%m-%d') != yesterday_str:
                    continue
            except:
                continue
        
        # 計算分數
        score = calculate_relevance(item)
        source = item.get('source', 'unknown')
        
        # 添加額外資訊
        enriched_item = {
            **item,
            'relevance_score': score,
            'source_label': SOURCE_LABELS.get(source, '📰 其他')
        }
        
        if source in grouped:
            grouped[source].append(enriched_item)
        else:
            grouped['unknown'].append(enriched_item)
    
    # 排序和限制
    taiwan_news = []
    international_news = []
    
    for source, items in grouped.items():
        if not items or source == 'unknown':
            continue
        
        config = FILTERS['sources'].get(source, {})
        max_items = config.get('max_items', 5)
        
        # 排序並篩選
        filtered = sorted(items, key=lambda x: x['relevance_score'], reverse=True)
        filtered = [item for item in filtered if item['relevance_score'] > 0]
        filtered = filtered[:max_items]
        
        # 分類本地與國際
        if source in ['technews', 'ithome', 'inside']:
            taiwan_news.extend(filtered)
        else:
            international_news.extend(filtered)
        
        logger.info(f"  {SOURCE_LABELS.get(source, source)}: {len(items)} → {len(filtered)}")
    
    # 混合排序策略：確保本地與國際新聞平衡
    final_items = []
    max_length = max(len(taiwan_news), len(international_news))
    
    for i in range(max_length):
        if i < len(taiwan_news):
            final_items.append(taiwan_news[i])
        if i < len(international_news):
            final_items.append(international_news[i])
    
    # 最終按分數重排（但保持一定多樣性）
    final_items.sort(key=lambda x: (
        # 先按分數分組
        -1 if x['relevance_score'] > 20 else (-2 if x['relevance_score'] > 10 else -3),
        # 同組內按分數排序
        -x['relevance_score']
    ))
    
    # 統計報告
    logger.info("\n📊 篩選結果總覽：")
    logger.info("【台灣新聞】")
    for source in ['technews', 'ithome', 'inside']:
        count = len([item for item in final_items if item['source'] == source])
        logger.info(f"  {SOURCE_LABELS[source]}: {count} 則")
    
    logger.info("\n【國際新聞】")
    for source in ['hackernews', 'techcrunch', 'openai', 'arstechnica', 'bair']:
        count = len([item for item in final_items if item['source'] == source])
        logger.info(f"  {SOURCE_LABELS[source]}: {count} 則")
    
    taiwan_count = len([i for i in final_items if i['source'] in ['technews', 'ithome', 'inside']])
    international_count = len(final_items) - taiwan_count
    
    logger.info(f"\n{'=' * 40}")
    logger.info(f"✅ 最終保留: {len(final_items)} 則")
    logger.info(f"  - 本地: {taiwan_count} 則")
    logger.info(f"  - 國際: {international_count} 則")
    logger.info(f"{'=' * 40}\n")
    
    return final_items
