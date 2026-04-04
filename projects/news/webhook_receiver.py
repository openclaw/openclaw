#!/usr/bin/env python3
"""
n8n Webhook 接收服務
接收 n8n 工作流程完成後的推送內容，並觸發本地發布流程
"""

from flask import Flask, request, jsonify
import json
import os
import sys
from datetime import datetime
from pathlib import Path
import logging

# 設定日誌
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('webhook_receiver.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# 配置
REPO_PATH = Path('/Users/thinkercafe/Documents/thinker-news')
SECRET_TOKEN = os.getenv('WEBHOOK_SECRET', 'your-secret-token-here')

class NewsPublisher:
    def __init__(self):
        self.repo_path = REPO_PATH
        
    def save_n8n_content(self, date_str: str, result_data: dict) -> bool:
        """保存 n8n 返回的內容"""
        try:
            if 'notion_version_for_storage' not in result_data:
                logger.error(f"Missing notion_version_for_storage in data: {list(result_data.keys())}")
                return False
            
            notion_content = result_data['notion_version_for_storage']
            
            # 移除 markdown 代碼塊包裹
            if notion_content.startswith('```markdown\n') and notion_content.endswith('\n```'):
                notion_content = notion_content[12:-4]
                logger.info("Removed markdown code block wrapper")
            
            # 添加標準標題格式
            final_content = f"# 📰 {date_str} 科技新聞精選（n8n高品質版本）\n\n> 由 n8n 專業工作流程精選並分析的每日科技新聞\n\n## 🔥 今日亮點\n\n" + notion_content
            
            # 保存 markdown 檔案
            md_file_path = self.repo_path / f'{date_str}_community_digest.md'
            with open(md_file_path, 'w', encoding='utf-8') as f:
                f.write(final_content)
            
            logger.info(f"Saved notion content to: {md_file_path.name}")
            
            # 保存 LINE 版本
            if 'line_version_for_publishing' in result_data:
                line_content = result_data['line_version_for_publishing']
                line_file_path = self.repo_path / f'{date_str}_line_digest.txt'
                
                with open(line_file_path, 'w', encoding='utf-8') as f:
                    f.write(line_content)
                
                logger.info(f"Saved LINE content to: {line_file_path.name}")
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to save n8n content: {str(e)}")
            return False
    
    def generate_html(self, date_str: str) -> bool:
        """使用 Gemini Layout Agent 生成 HTML"""
        try:
            from generate_daily_news import ThinkerNewsPublisher
            publisher = ThinkerNewsPublisher()
            return publisher.use_gemini_layout_agent(date_str)
        except Exception as e:
            logger.error(f"Failed to generate HTML: {str(e)}")
            return False
    
    def update_and_publish(self, date_str: str) -> bool:
        """更新首頁並發布到 GitHub"""
        try:
            from generate_daily_news import ThinkerNewsPublisher
            publisher = ThinkerNewsPublisher()
            
            # 更新首頁
            if not publisher.update_index_page(date_str, "今日AI科技重點新聞精選"):
                return False
            
            # 提交到 GitHub
            return publisher.commit_and_push(date_str)
            
        except Exception as e:
            logger.error(f"Failed to update and publish: {str(e)}")
            return False

@app.route('/', methods=['GET'])
def health_check():
    return jsonify({
        "status": "healthy",
        "service": "n8n webhook receiver",
        "timestamp": datetime.now().isoformat(),
        "version": "1.0"
    })

@app.route('/webhook/n8n/news-complete', methods=['POST'])
def receive_n8n_news():
    """接收 n8n 完成的新聞內容"""
    try:
        # 驗證請求
        auth_header = request.headers.get('Authorization')
        if not auth_header or auth_header != f'Bearer {SECRET_TOKEN}':
            logger.warning(f"Unauthorized access from {request.remote_addr}")
            return jsonify({"error": "Unauthorized"}), 401
        
        # 解析請求數據
        if not request.is_json:
            return jsonify({"error": "Content-Type must be application/json"}), 400
        
        data = request.get_json()
        logger.info(f"Received webhook data keys: {list(data.keys())}")
        
        # 提取日期
        date_str = data.get('final_date') or datetime.now().strftime('%Y-%m-%d')
        logger.info(f"Processing news for date: {date_str}")
        
        # 初始化發布器
        publisher = NewsPublisher()
        
        # 步驟 1: 保存 n8n 內容
        if not publisher.save_n8n_content(date_str, data):
            return jsonify({"error": "Failed to save n8n content"}), 500
        
        # 步驟 2: 生成 HTML
        if not publisher.generate_html(date_str):
            logger.warning("HTML generation failed, but content saved")
        
        # 步驟 3: 更新首頁並發布
        if not publisher.update_and_publish(date_str):
            logger.warning("Publishing failed, but content processed")
        
        # 成功回應
        response = {
            "status": "success",
            "message": f"News for {date_str} processed successfully",
            "date": date_str,
            "timestamp": datetime.now().isoformat(),
            "website": f"https://thinkercafe-tw.github.io/thinker-news/{date_str}.html"
        }
        
        logger.info(f"Successfully processed news for {date_str}")
        return jsonify(response), 200
        
    except Exception as e:
        logger.error(f"Error processing webhook: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/webhook/test', methods=['POST'])
def test_endpoint():
    """測試端點"""
    data = request.get_json() if request.is_json else {}
    logger.info(f"Test endpoint called with: {data}")
    
    return jsonify({
        "status": "test_success",
        "received_data": data,
        "timestamp": datetime.now().isoformat()
    })

if __name__ == '__main__':
    # 檢查環境
    if not REPO_PATH.exists():
        logger.error(f"Repository path does not exist: {REPO_PATH}")
        sys.exit(1)
    
    logger.info(f"Starting webhook receiver service")
    logger.info(f"Repository path: {REPO_PATH}")
    logger.info(f"Secret token configured: {'Yes' if SECRET_TOKEN != 'your-secret-token-here' else 'No'}")
    
    # 啟動服務
    port = int(os.getenv('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)