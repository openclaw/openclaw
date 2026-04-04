/**
 * 思考者入口 - 頁面模式切換系統
 * 在同一頁面實現公開模式 ↔ 思考者模式的無縫切換
 */

class ThinkerSecretEntrance {
    constructor() {
        this.password = 'thinker';
        this.isActivated = false;
        this.originalContent = null;
        this.init();
    }
    
    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.createThinkerButton());
        } else {
            this.createThinkerButton();
        }
        
        if (this.isDevelopmentMode()) {
            console.log('🧠 思考者入口已載入，密碼：thinker');
        }
    }
    
    createThinkerButton() {
        // 尋找插入位置
        let targetElement = this.findInsertionPoint();
        
        // 創建思考者入口按鈕
        const thinkerButton = document.createElement('a');
        thinkerButton.id = 'thinkerEntrance';
        thinkerButton.href = '#';
        thinkerButton.innerHTML = '🧠 思考者入口';
        thinkerButton.style.cssText = `
            display: inline-block;
            background: rgba(255, 255, 255, 0.2);
            color: white;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 25px;
            margin: 0 10px;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.3);
        `;
        
        // 點擊事件
        thinkerButton.addEventListener('click', (e) => {
            e.preventDefault();
            this.promptPassword();
        });
        
        // 懸停效果
        thinkerButton.addEventListener('mouseenter', () => {
            thinkerButton.style.background = 'rgba(255, 255, 255, 0.3)';
            thinkerButton.style.transform = 'translateY(-2px)';
        });
        
        thinkerButton.addEventListener('mouseleave', () => {
            thinkerButton.style.background = 'rgba(255, 255, 255, 0.2)';
            thinkerButton.style.transform = 'translateY(0)';
        });
        
        // 添加到頁面
        this.insertButton(targetElement, thinkerButton);
        
        if (this.isDevelopmentMode()) {
            console.log('🧠 思考者入口按鈕已添加');
        }
    }
    
    findInsertionPoint() {
        // 強制添加到頁面底部，確保一定能看到
        return document.body;
    }
    
    insertButton(targetElement, button) {
        if (targetElement === document.body) {
            // 如果是添加到 body，創建一個固定底部的容器
            const footer = document.createElement('div');
            footer.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 1000;
            `;
            footer.appendChild(button);
            document.body.appendChild(footer);
        } else {
            // 添加到現有的導航區域
            targetElement.appendChild(button);
        }
    }
    
    promptPassword() {
        const password = prompt('🧠 歡迎來到思考者入口\\n\\n請輸入密碼：');
        
        if (password === this.password) {
            this.switchToThinkerMode();
        } else if (password !== null) {
            alert('❌ 密碼錯誤\\n\\n提示：密碼就是 "thinker"');
        }
    }
    
    switchToThinkerMode() {
        // 保存原始內容
        this.originalContent = document.body.innerHTML;
        
        // 顯示切換動畫
        this.showTransitionEffect();
        
        // 1秒後替換內容
        setTimeout(() => {
            this.loadThinkerInterface();
        }, 1000);
    }
    
    showTransitionEffect() {
        // 創建全屏過渡效果
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.5s ease;
        `;
        
        const text = document.createElement('div');
        text.innerHTML = `
            <div style="text-align: center; color: white;">
                <div style="font-size: 4em; margin-bottom: 20px; animation: pulse 1s infinite;">🧠</div>
                <div style="font-size: 1.5em; font-weight: 600;">思考者模式已激活</div>
                <div style="font-size: 1em; margin-top: 10px; opacity: 0.8;">正在載入 Agent 007 控制面板...</div>
            </div>
        `;
        
        overlay.appendChild(text);
        document.body.appendChild(overlay);
        
        // 添加脈衝動畫
        const style = document.createElement('style');
        style.textContent = `
            @keyframes pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.1); }
            }
        `;
        document.head.appendChild(style);
        
        // 淡入效果
        setTimeout(() => {
            overlay.style.opacity = '1';
        }, 10);
        
        // 1.5秒後移除
        setTimeout(() => {
            overlay.remove();
        }, 1500);
    }
    
    async loadThinkerInterface() {
        // 替換整個頁面內容為思考者面板
        document.body.innerHTML = `
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft JhengHei', sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    animation: fadeIn 0.5s ease;
                }
                
                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                
                .thinker-container {
                    max-width: 1200px;
                    width: 95%;
                    margin: 20px auto;
                    padding: 20px;
                }
                
                .thinker-header {
                    background: rgba(255, 255, 255, 0.95);
                    backdrop-filter: blur(20px);
                    border-radius: 20px;
                    padding: 30px;
                    text-align: center;
                    margin-bottom: 20px;
                    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
                }
                
                .thinker-title {
                    font-size: 2.2em;
                    margin-bottom: 10px;
                    background: linear-gradient(45deg, #667eea, #764ba2);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                
                .thinker-subtitle {
                    color: #666;
                    font-size: 1.2em;
                }
                
                .status-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                    gap: 20px;
                    margin-bottom: 20px;
                }
                
                .status-card {
                    background: rgba(255, 255, 255, 0.95);
                    backdrop-filter: blur(20px);
                    border-radius: 20px;
                    padding: 25px;
                    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
                    border-left: 4px solid #667eea;
                }
                
                .status-title {
                    font-weight: 600;
                    margin-bottom: 10px;
                    color: #333;
                }
                
                .status-value {
                    font-size: 1.3em;
                    font-weight: 700;
                    color: #667eea;
                }
                
                .exit-btn {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: rgba(255, 255, 255, 0.2);
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 20px;
                    cursor: pointer;
                    backdrop-filter: blur(10px);
                    transition: all 0.3s ease;
                }
                
                .exit-btn:hover {
                    background: rgba(255, 255, 255, 0.3);
                }
                
                .loading {
                    text-align: center;
                    margin: 20px 0;
                }
                
                .spinner {
                    border: 3px solid rgba(102, 126, 234, 0.3);
                    border-top: 3px solid #667eea;
                    border-radius: 50%;
                    width: 40px;
                    height: 40px;
                    animation: spin 1s linear infinite;
                    margin: 0 auto 15px;
                }
                
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
            
            <div class="thinker-container">
                <button class="exit-btn" onclick="window.thinkerEntrance.exitThinkerMode()">
                    ← 返回新聞模式
                </button>
                
                <div class="thinker-header">
                    <h1 class="thinker-title">🤖 Agent 007 控制中心</h1>
                    <p class="thinker-subtitle">專屬於思考者的智能分析面板</p>
                </div>
                
                <div class="loading" id="loading">
                    <div class="spinner"></div>
                    <p style="color: white;">正在載入 Agent 007 分析數據...</p>
                </div>
                
                <div class="status-grid" id="statusGrid">
                    <!-- 動態載入狀態數據 -->
                </div>
            </div>
        `;
        
        // 載入 Agent 007 數據
        this.loadAgent007Data();
    }
    
    async loadAgent007Data() {
        const loading = document.getElementById('loading');
        const statusGrid = document.getElementById('statusGrid');
        
        try {
            // 獲取今日早報數據
            const reportResponse = await fetch('https://historic-meetings-slides-comply.trycloudflare.com/api/v1/reports/daily?format=json');
            const reportData = await reportResponse.json();
            
            // 獲取排程建議
            const scheduleResponse = await fetch('https://historic-meetings-slides-comply.trycloudflare.com/api/v1/reports/schedule-suggestion');
            const scheduleData = await scheduleResponse.json();
            
            // 更新狀態網格
            this.updateStatusGrid(reportData, scheduleData);
            
        } catch (error) {
            console.error('載入數據失敗:', error);
            statusGrid.innerHTML = `
                <div class="status-card">
                    <div class="status-title">⚠️ 無法連接到 Agent 007 服務</div>
                    <div class="status-value">請確認本地服務正在運行</div>
                </div>
            `;
        } finally {
            loading.style.display = 'none';
        }
    }
    
    updateStatusGrid(reportData, scheduleData) {
        const statusGrid = document.getElementById('statusGrid');
        const report = reportData.report || {};
        
        const statusCards = [
            {
                title: '📅 日期',
                value: report.date || '今日'
            },
            {
                title: '🧠 記憶分析',
                value: `${report.memory_analysis?.insights_count || 0} 個洞察`
            },
            {
                title: '💭 情緒狀態', 
                value: report.memory_analysis?.emotional_state || '平靜'
            },
            {
                title: '🎯 焦點領域',
                value: report.memory_analysis?.focus_areas?.join(', ') || '無特定焦點'
            },
            {
                title: '📊 課程準備',
                value: `還有 ${report.course_preparation?.days_until_course || 'N/A'} 天`
            },
            {
                title: '🎙️ Podcast 機會',
                value: `${report.memory_analysis?.podcast_topics?.length || 0} 個主題`
            }
        ];
        
        statusGrid.innerHTML = statusCards.map(card => `
            <div class="status-card">
                <div class="status-title">${card.title}</div>
                <div class="status-value">${card.value}</div>
            </div>
        `).join('');
    }
    
    exitThinkerMode() {
        // 顯示退出動畫
        this.showExitTransition();
        
        // 1秒後恢復原始內容
        setTimeout(() => {
            if (this.originalContent) {
                document.body.innerHTML = this.originalContent;
                this.isActivated = false;
                
                // 重新初始化按鈕
                setTimeout(() => {
                    this.createThinkerButton();
                }, 100);
            }
        }, 1000);
    }
    
    showExitTransition() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.5s ease;
        `;
        
        const text = document.createElement('div');
        text.innerHTML = `
            <div style="text-align: center; color: white;">
                <div style="font-size: 4em; margin-bottom: 20px;">📰</div>
                <div style="font-size: 1.5em; font-weight: 600;">返回新聞模式</div>
                <div style="font-size: 1em; margin-top: 10px; opacity: 0.8;">正在切換回公開頁面...</div>
            </div>
        `;
        
        overlay.appendChild(text);
        document.body.appendChild(overlay);
        
        setTimeout(() => {
            overlay.style.opacity = '1';
        }, 10);
        
        setTimeout(() => {
            overlay.remove();
        }, 1500);
    }
    
    isDevelopmentMode() {
        return window.location.hostname === 'localhost' || 
               window.location.hostname === '127.0.0.1' ||
               window.location.hostname.includes('dev');
    }
    
    // 公共API，供其他腳本調用
    static initSecretEntrance() {
        if (!window.thinkerEntrance) {
            window.thinkerEntrance = new ThinkerSecretEntrance();
        }
        return window.thinkerEntrance;
    }
}

// 自動初始化（除非明確禁用）
if (!window.DISABLE_THINKER_ENTRANCE) {
    // 等待 DOM 加載完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ThinkerSecretEntrance.initSecretEntrance();
        });
    } else {
        ThinkerSecretEntrance.initSecretEntrance();
    }
}

// 導出供模組化使用
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThinkerSecretEntrance;
}