"""
HTML 生成模組
使用 Jinja2 模板生成 HTML 頁面
混合方式：固定的 <head> + AI 生成的 <body> 內容
"""

import logging
from pathlib import Path
from datetime import datetime, timedelta
from jinja2 import Template

logger = logging.getLogger(__name__)

# ============================================
# HTML 模板
# ============================================

DAILY_NEWS_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ date }} AI 科技日報 | Thinker News</title>
    <meta name="description" content="今日AI科技重點新聞精選">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤖</text></svg>">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft JhengHei', sans-serif;
            line-height: 1.7;
            color: #333;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        
        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        
        .back-link {
            display: inline-block;
            margin-bottom: 20px;
            color: white;
            text-decoration: none;
            background: rgba(255, 255, 255, 0.2);
            padding: 10px 20px;
            border-radius: 20px;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
        }
        
        .back-link:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateX(-5px);
        }
        
        .article-header {
            text-align: center;
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px 30px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }
        
        .article-date {
            font-size: 1.1em;
            color: #667eea;
            font-weight: 600;
            margin-bottom: 15px;
        }
        
        .article-title {
            font-size: 2.2em;
            font-weight: 800;
            margin-bottom: 20px;
            background: linear-gradient(45deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            line-height: 1.3;
        }
        
        .article-subtitle {
            font-size: 1.2em;
            color: #666;
            font-weight: 400;
        }

        /* 🎯 學習焦點區塊 */
        .learning-focus {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 20px;
            padding: 30px 40px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(102, 126, 234, 0.3);
            color: white;
        }

        .learning-focus h3 {
            font-size: 1.5em;
            font-weight: 700;
            margin-bottom: 15px;
            color: white;
        }

        .learning-focus p {
            font-size: 1.05em;
            line-height: 1.7;
            margin-bottom: 20px;
            color: rgba(255, 255, 255, 0.95);
        }

        .learning-focus strong {
            color: #FFE66D;
            font-weight: 600;
        }

        .focus-cta {
            display: inline-block;
            background: white;
            color: #667eea;
            padding: 12px 28px;
            border-radius: 25px;
            text-decoration: none;
            font-weight: 600;
            font-size: 1.05em;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
        }

        .focus-cta:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
            color: #764ba2;
        }

        .content-section {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }

        .content-section h2 {
            margin-top: 30px;
            margin-bottom: 15px;
            color: #667eea;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }

        .content-section h2:first-child {
            margin-top: 0;
        }

        .content-section h3 {
            margin-top: 25px;
            margin-bottom: 12px;
            color: #764ba2;
        }

        .content-section p {
            margin-bottom: 15px;
            line-height: 1.8;
        }

        .content-section a {
            color: #667eea;
            text-decoration: none;
            border-bottom: 1px solid #667eea;
            transition: all 0.3s ease;
        }

        .content-section a:hover {
            color: #764ba2;
            border-bottom-color: #764ba2;
        }

        .content-section strong {
            font-weight: 600;
            color: #333;
        }

        .content-section ul, .content-section ol {
            margin-left: 25px;
            margin-bottom: 15px;
        }

        .content-section li {
            margin-bottom: 8px;
            line-height: 1.7;
        }
        
        .line-section {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
        }
        
        .line-content {
            background: rgba(255,255,255,0.1);
            padding: 20px;
            border-radius: 15px;
            margin: 20px 0;
        }

        .line-content p {
            margin-bottom: 12px;
            line-height: 1.7;
        }

        .line-content strong {
            font-weight: 600;
        }

        .line-content a {
            color: white;
            text-decoration: underline;
        }
        
        .footer-nav {
            text-align: center;
            padding: 30px;
            color: white;
        }
        
        .nav-button {
            display: inline-block;
            background: rgba(255, 255, 255, 0.2);
            color: white;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 25px;
            margin: 0 10px;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
        }
        
        .nav-button:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }
        
        @media (max-width: 600px) {
            .container {
                padding: 15px;
            }
            
            .article-header {
                padding: 25px 20px;
            }
            
            .article-title {
                font-size: 1.8em;
            }
            
            .content-section {
                padding: 25px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <a href="./index.html" class="back-link">← 返回首頁</a>
        
        <header class="article-header">
            <div class="article-date">📅 {{ date }}</div>
            <h1 class="article-title">🤖 AI 科技日報精選</h1>
            <p class="article-subtitle">今日AI科技重點新聞</p>
        </header>

        <!-- 🎯 學習焦點區塊 -->
{{ learning_focus_block }}

        <div class="content-section">
{{ notion_content }}
        </div>
        
        <div class="content-section line-section">
            <h2 style="color: white; border-bottom: 3px solid white;">📱 LINE 精華版</h2>
            <div class="line-content">
{{ line_content }}
            </div>
            
            <div style="text-align: center; margin-top: 20px;">
                <p style="font-size: 0.9em; opacity: 0.8;">
                    💡 此精華版專為LINE推送設計 | 完整分析請閱讀上方詳細報告
                </p>
            </div>
        </div>
        
        <div class="footer-nav">
            <a href="./index.html" class="nav-button">🏠 返回首頁</a>
            <a href="https://github.com/ThinkerCafe-tw/thinker-news" class="nav-button" target="_blank">⭐ GitHub</a>
        </div>
    </div>
    
    <script>
        // 頁面載入動畫
        document.addEventListener('DOMContentLoaded', function() {
            const sections = document.querySelectorAll('.content-section');
            sections.forEach((section, index) => {
                section.style.opacity = '0';
                section.style.transform = 'translateY(20px)';
                setTimeout(() => {
                    section.style.transition = 'all 0.6s ease';
                    section.style.opacity = '1';
                    section.style.transform = 'translateY(0)';
                }, index * 150);
            });
        });
    </script>
<script src="./thinker_secret_entrance.js"></script>
</body>
</html>"""


def generate_daily_html(final_output: dict, html_full_content: str = None) -> str:
    """
    生成今日新聞 HTML 頁面
    完全對齊 n8n 架構：AI 生成完整的 HTML 文檔

    Args:
        final_output: 組裝後的最終輸出
        html_full_content: AI 生成的完整 HTML 文檔（可選）

    Returns:
        HTML 文件路徑
    """
    logger.info("📝 生成今日新聞 HTML...")

    date = final_output['final_date']

    # 如果有 AI 生成的完整 HTML，直接使用（對齊 n8n 架構）
    if html_full_content:
        html_content = html_full_content
    else:
        # 降級方案：使用舊的模板方式
        logger.warning("⚠️  未提供 HTML body 內容，使用降級方案")
        notion_content = final_output['notion_content']
        line_content = final_output['line_content']
        learning_focus_text = final_output.get('learning_focus', '')

        # 生成學習焦點區塊 HTML
        if learning_focus_text:
            # 將 learning_focus_text 轉換為 HTML（markdown 格式）
            learning_focus_html = learning_focus_text.replace('\n\n', '</p><p>').replace('**', '<strong>').replace('**', '</strong>')
            learning_focus_block = f'''        <div class="learning-focus">
            <div>{learning_focus_html}</div>
        </div>'''
        else:
            learning_focus_block = ''

        template = Template(DAILY_NEWS_TEMPLATE)
        html_content = template.render(
            date=date,
            notion_content=notion_content,
            line_content=line_content,
            learning_focus_block=learning_focus_block
        )

    # 寫入文件
    output_path = Path(f"{date}.html")
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html_content)

    logger.info(f"✅ HTML 文件已生成: {output_path}")
    return str(output_path)


def update_index_html(today_date: str) -> str:
    """
    更新首頁 index.html

    Args:
        today_date: 今日日期

    Returns:
        index.html 文件路徑
    """
    logger.info("📝 更新首頁 index.html...")

    # 計算明日日期
    today_dt = datetime.strptime(today_date, '%Y-%m-%d')
    tomorrow_dt = today_dt + timedelta(days=1)
    tomorrow_date = tomorrow_dt.strftime('%Y-%m-%d')

    # 完整的 index.html 模板（對齊原版）
    index_template = """<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Thinker News - AI 科技日報精選</title>
    <meta name="description" content="為資料科學初學者提供每日精選的AI科技新聞，涵蓋工具應用、產業趨勢與深度分析">
    <!-- 強制重新載入，避免緩存問題 -->
    <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
    <meta http-equiv="Pragma" content="no-cache">
    <meta http-equiv="Expires" content="0">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤖</text></svg>">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft JhengHei', sans-serif;
            line-height: 1.6;
            color: #333;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }

        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
        }

        header {
            text-align: center;
            margin-bottom: 40px;
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px 20px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        }

        h1 {
            font-size: 2.8em;
            margin-bottom: 10px;
            background: linear-gradient(45deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            font-weight: 800;
        }

        .subtitle {
            font-size: 1.3em;
            color: #666;
            margin-bottom: 20px;
            font-weight: 300;
        }

        .stats {
            display: flex;
            justify-content: center;
            gap: 40px;
            margin-top: 30px;
        }

        .stat {
            text-align: center;
            padding: 15px;
            background: rgba(255, 255, 255, 0.7);
            border-radius: 15px;
            min-width: 100px;
            transition: all 0.3s ease;
        }

        .stat:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.2);
        }

        .stat-number {
            font-size: 2.2em;
            font-weight: bold;
            color: #667eea;
            margin-bottom: 5px;
        }

        .stat-label {
            font-size: 0.9em;
            color: #888;
            font-weight: 500;
        }

        .news-section {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            margin-bottom: 30px;
        }

        .section-title {
            font-size: 1.8em;
            color: #667eea;
            margin-bottom: 25px;
            border-bottom: 3px solid #667eea;
            padding-bottom: 10px;
            font-weight: 700;
        }

        .news-item {
            border-left: 4px solid #667eea;
            padding: 25px 20px;
            margin-bottom: 20px;
            background: rgba(102, 126, 234, 0.05);
            border-radius: 0 15px 15px 0;
            transition: all 0.3s ease;
        }

        .news-item:hover {
            transform: translateX(10px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.15);
            background: rgba(102, 126, 234, 0.1);
        }

        .news-date {
            font-size: 1.1em;
            font-weight: 600;
            color: #667eea;
            margin-bottom: 10px;
        }

        .news-title {
            font-size: 1.2em;
            color: #333;
            margin-bottom: 15px;
            font-weight: 600;
            line-height: 1.4;
        }

        .news-description {
            color: #666;
            margin-bottom: 15px;
            line-height: 1.5;
        }

        .news-link {
            display: inline-block;
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 25px;
            font-size: 0.95em;
            font-weight: 600;
            transition: all 0.3s ease;
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.3);
        }

        .news-link:hover {
            transform: translateY(-3px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
        }

        .news-link.disabled {
            opacity: 0.6;
            cursor: not-allowed;
            background: #ccc;
        }

        .news-link.disabled:hover {
            transform: none;
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.3);
        }

        .footer {
            text-align: center;
            margin-top: 40px;
            padding: 30px 20px;
            color: white;
            font-size: 1em;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
        }

        .footer p {
            margin-bottom: 10px;
        }

        .emoji {
            font-size: 1.2em;
        }

        .github-link {
            display: inline-block;
            margin-top: 20px;
            color: white;
            text-decoration: none;
            background: rgba(255, 255, 255, 0.2);
            padding: 10px 20px;
            border-radius: 20px;
            transition: all 0.3s ease;
        }

        .github-link:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }

        @media (max-width: 600px) {
            .container {
                padding: 15px;
            }

            h1 {
                font-size: 2.2em;
            }

            .stats {
                flex-direction: column;
                gap: 20px;
                align-items: center;
            }

            .news-section {
                padding: 25px;
            }

            .news-item {
                padding: 20px 15px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1><span class="emoji">🤖</span> Thinker News</h1>
            <p class="subtitle">為資料科學初學者精心打造的 AI 科技日報</p>
            <div class="stats">
                <div class="stat">
                    <div class="stat-number">08:30</div>
                    <div class="stat-label">每日更新</div>
                </div>
                <div class="stat">
                    <div class="stat-number">AI</div>
                    <div class="stat-label">智能篩選</div>
                </div>
                <div class="stat">
                    <div class="stat-number">5-8</div>
                    <div class="stat-label">分鐘閱讀</div>
                </div>
            </div>
        </header>

        <div class="news-section">
            <h2 class="section-title">📅 最新日報</h2>

            <div class="news-item">
                <div class="news-date">📅 {{ today_date }} (今日)</div>
                <div class="news-title">🚀 今日AI科技重點新聞精選</div>
                <div class="news-description">
                    今日AI科技重點新聞精選，涵蓋最新的工具應用、產業趨勢與安全警報。
                </div>
                <a href="./{{ today_date }}.html" class="news-link">閱讀完整報告 📖</a>
            </div>

            <div class="news-item">
                <div class="news-date">📅 {{ tomorrow_date }}</div>
                <div class="news-title">🔄 明日精彩內容準備中...</div>
                <div class="news-description">
                    我們的AI編輯團隊正在為您精選明日最重要的科技新聞。請於明日08:30回訪查看最新內容。
                </div>
                <a href="#" class="news-link disabled">敬請期待 ⏳</a>
            </div>
        </div>

        <div class="news-section">
            <h2 class="section-title">📚 歷史日報</h2>

            <div class="news-item">
                <div class="news-date">📅 2025-09-24</div>
                <div class="news-title">🚀 今日AI科技重點新聞精選</div>
                <div class="news-description">
                    今日AI科技重點新聞精選，涵蓋最新的工具應用、產業趨勢與安全警報。
                </div>
                <a href="./2025-09-24.html" class="news-link">閱讀完整報告 📖</a>
            </div>

            <div class="news-item">
                <div class="news-date">📅 2025-09-23</div>
                <div class="news-title">🚀 Nvidia投資OpenAI巨額資金，AI安全挑戰並存</div>
                <div class="news-description">
                    Nvidia 與 OpenAI 達成協議投資高達1000億美元，ShadowLeak漏洞透過ChatGPT洩漏Gmail數據，AI基礎設施交易推動產業繁榮。
                </div>
                <a href="./2025-09-23.html" class="news-link">閱讀完整報告 📖</a>
            </div>
        </div>

        <div class="news-section">
            <h2 class="section-title">📖 關於 Thinker News</h2>
            <div style="color: #666; line-height: 1.7; font-size: 1.1em;">
                <p><strong>🎯 專為誰設計？</strong></p>
                <p>• 年齡：30-60歲，具備R或Python資料分析經驗</p>
                <p>• 目標：對資料科學好奇，渴望踏入AI領域的初學者</p>
                <br>
                <p><strong>✨ 我們的特色：</strong></p>
                <p>• 🤖 AI智能篩選：從全球頂尖科技媒體精選相關內容</p>
                <p>• 📊 結構化分析：工具應用、產業趨勢、安全警報、深度觀點</p>
                <p>• 🎯 量身打造：專為初學者設計的內容深度與語言風格</p>
                <p>• ⏰ 準時更新：每日08:30準時發布，養成學習習慣</p>
            </div>
        </div>

        <div class="news-section">
            <h2 class="section-title">🧠 學習洞察</h2>
            <div style="color: #666; line-height: 1.7; font-size: 1.1em; margin-bottom: 20px;">
                <p>從我們的教學經驗與策略思考中提煉的深度學習洞察，幫助你更好地理解技術學習的本質。</p>
            </div>

            <div class="news-item" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);">
                <div class="news-date" style="color: rgba(255,255,255,0.9); font-weight: 600;">💡 最新洞察</div>
                <div class="news-title" style="color: #ffffff; font-weight: 700;">程式語言的演進思維：從工程師代碼到自然語言</div>
                <div class="news-description" style="color: rgba(255,255,255,0.85); line-height: 1.6;">
                    爬蟲技術本質上就是早期工程師寫給網站的「提示詞」，只是那時還不夠智能。現在的AI提示詞，就像是新時代的程式語言 - 我們的自然語言對話，已經具備了程式語言的功能。
                </div>
                <div style="margin-top: 15px;">
                    <span style="background: rgba(255,255,255,0.25); color: white; padding: 8px 15px; border-radius: 20px; font-size: 0.85em; margin-right: 10px; font-weight: 500;">🎯 初學者</span>
                    <span style="background: rgba(255,255,255,0.25); color: white; padding: 8px 15px; border-radius: 20px; font-size: 0.85em; font-weight: 500;">📚 學習方法論</span>
                </div>
            </div>

            <div class="news-item" style="background: rgba(240, 147, 251, 0.08); border-left: 4px solid #f093fb; border-radius: 12px;">
                <div class="news-date" style="color: #f093fb; font-weight: 600;">🚀 教學心得</div>
                <div class="news-title" style="color: #333; font-weight: 700;">階段化學習設計：從淺入深的認知建構</div>
                <div class="news-description" style="color: #555; line-height: 1.6;">
                    提示詞可以很簡單（「用老闆的語氣說話」），也可以很複雜（多層次思維框架）。關鍵是分階段教學：先讓學習者嘗到甜頭，再逐步深入核心概念，避免一開始就被複雜度嚇跑。
                </div>
                <div style="margin-top: 15px;">
                    <span style="background: linear-gradient(45deg, #f093fb, #f5576c); color: white; padding: 8px 15px; border-radius: 20px; font-size: 0.85em; margin-right: 10px; font-weight: 500; box-shadow: 0 2px 8px rgba(240, 147, 251, 0.3);">👥 所有人</span>
                    <span style="background: linear-gradient(45deg, #f093fb, #f5576c); color: white; padding: 8px 15px; border-radius: 20px; font-size: 0.85em; font-weight: 500; box-shadow: 0 2px 8px rgba(240, 147, 251, 0.3);">🎓 教學方法</span>
                </div>
            </div>

            <div class="news-item" style="background: rgba(118, 75, 162, 0.08); border-left: 4px solid #764ba2; border-radius: 12px;">
                <div class="news-date" style="color: #764ba2; font-weight: 600;">🤝 團隊協作洞察</div>
                <div class="news-title" style="color: #333; font-weight: 700;">AI實現的兩種哲學：算法派 vs 提示詞派</div>
                <div class="news-description" style="color: #555; line-height: 1.6;">
                    在開發AI算命系統時發現了兩種實現思路：一是內建完整算法，二是運用精準提示詞。實戰證明，在產品迭代階段，「巧勁」往往比「笨功夫」更有效。關鍵是找到最小可行性方案，先跑起來再優化。
                </div>
                <div style="margin-top: 15px;">
                    <span style="background: linear-gradient(45deg, #764ba2, #667eea); color: white; padding: 8px 15px; border-radius: 20px; font-size: 0.85em; margin-right: 10px; font-weight: 500; box-shadow: 0 2px 8px rgba(118, 75, 162, 0.3);">🔧 開發者</span>
                    <span style="background: linear-gradient(45deg, #764ba2, #667eea); color: white; padding: 8px 15px; border-radius: 20px; font-size: 0.85em; font-weight: 500; box-shadow: 0 2px 8px rgba(118, 75, 162, 0.3);">⚡ 快速迭代</span>
                </div>
            </div>

            <div class="news-item" style="background: rgba(102, 126, 234, 0.08); border-left: 4px solid #667eea; border-radius: 12px;">
                <div class="news-date" style="color: #667eea; font-weight: 600;">🚀 工作流進化</div>
                <div class="news-title" style="color: #333; font-weight: 700;">自動化的真諦：放大創造力而非取代思考</div>
                <div class="news-description" style="color: #555; line-height: 1.6;">
                    從手動Notion更新 → N8N自動化 → ChatGPT+Claude Code智能整合。真正的自動化不是取代人的思考，而是將思考過程系統化、可重複化。最好的自動化工具是那些能夠放大人的創造力的工具。
                </div>
                <div style="margin-top: 15px;">
                    <span style="background: linear-gradient(45deg, #667eea, #764ba2); color: white; padding: 8px 15px; border-radius: 20px; font-size: 0.85em; margin-right: 10px; font-weight: 500; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);">🤖 自動化</span>
                    <span style="background: linear-gradient(45deg, #667eea, #764ba2); color: white; padding: 8px 15px; border-radius: 20px; font-size: 0.85em; font-weight: 500; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);">💡 工作流程</span>
                </div>
            </div>

            <div style="text-align: center; margin-top: 30px; padding: 20px; background: rgba(102, 126, 234, 0.05); border-radius: 15px;">
                <p style="color: #667eea; font-weight: 600; margin-bottom: 10px;">💎 想看更多學習洞察？</p>
                <p style="color: #888; font-size: 0.95em;">我們定期從教學經驗中提煉深度思考，分享給學習社群。</p>
                <button onclick="showSubscriptionForm()" style="display: inline-block; margin-top: 15px; background: linear-gradient(45deg, #667eea, #764ba2); color: white; border: none; padding: 12px 24px; border-radius: 25px; font-size: 0.95em; font-weight: 600; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3); transition: all 0.3s ease; cursor: pointer;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 20px rgba(102, 126, 234, 0.4)'" onmouseout="this.style.transform='translateY(0px)'; this.style.boxShadow='0 4px 15px rgba(102, 126, 234, 0.3)'">📧 訂閱洞察更新</button>
            </div>
        </div>

        <div class="footer">
            <p><span class="emoji">🚀</span> 讓複雜的 AI 世界變得簡單易懂</p>
            <p><span class="emoji">💡</span> 由 AI 驅動 | 為初學者打造 | 每日準時更新</p>
            <a href="https://github.com/ThinkerCafe-tw/thinker-news" class="github-link" target="_blank">
                <span class="emoji">⭐</span> 在 GitHub 上支持我們
            </a>
        </div>
    </div>

    <script>
        // 互動效果
        document.addEventListener('DOMContentLoaded', function() {
            // 統計數字動畫
            const statNumbers = document.querySelectorAll('.stat-number');
            statNumbers.forEach(stat => {
                stat.addEventListener('mouseenter', function() {
                    this.style.transform = 'scale(1.1)';
                });
                stat.addEventListener('mouseleave', function() {
                    this.style.transform = 'scale(1)';
                });
            });

            // 禁用連結點擊
            const disabledLinks = document.querySelectorAll('.news-link.disabled');
            disabledLinks.forEach(link => {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                });
            });

            // 頁面載入動畫
            const newsItems = document.querySelectorAll('.news-item');
            newsItems.forEach((item, index) => {
                item.style.opacity = '0';
                item.style.transform = 'translateY(20px)';
                setTimeout(() => {
                    item.style.transition = 'all 0.6s ease';
                    item.style.opacity = '1';
                    item.style.transform = 'translateY(0)';
                }, index * 200);
            });
        });
    </script>

    <!-- Email 訂閱功能 -->
    <script src="email_subscription_handler.js"></script>
</body>
</html>"""

    # 渲染模板
    template = Template(index_template)
    html_content = template.render(
        today_date=today_date,
        tomorrow_date=tomorrow_date
    )

    # 寫入文件
    output_path = Path('index.html')
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html_content)

    logger.info(f"✅ index.html 已更新")
    return str(output_path)
