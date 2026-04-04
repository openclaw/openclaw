// ===== AI 禮包系統 - 核心邏輯 =====

// ===== 全域變數 =====
let currentGiftConfig = null;
let currentGift = '';
let userEmail = '';
let completedPrompts = 0;

// ===== 初始化 =====
async function initGiftPage() {
    // 先檢查 URL 參數是否有 password
    const urlParams = new URLSearchParams(window.location.search);
    const urlPassword = urlParams.get('password');

    let password = localStorage.getItem('gift_password');

    // 如果 URL 有密碼，優先使用並存入 localStorage
    if (urlPassword) {
        password = urlPassword.toUpperCase();
        localStorage.setItem('gift_password', password);
    }

    // 如果還是沒有密碼，導回驗證頁
    if (!password) {
        window.location.href = '/ai/gift';
        return;
    }

    try {
        const allConfigs = await fetch('/ai/gift-config.json').then(r => r.json());
        const config = allConfigs[password];

        if (!config) {
            alert('配置檔案錯誤');
            window.location.href = '/ai/gift';
            return;
        }

        // 檢查過期
        if (config.meta.expires !== 'false' && new Date() > new Date(config.meta.expires)) {
            showExpired();
            return;
        }

        // 儲存配置
        currentGiftConfig = config;

        // 渲染頁面
        renderPage(config);

        // 追蹤
        trackEvent('gift_page_loaded', {
            password: password,
            source: config.meta.source
        });
    } catch (error) {
        console.error('載入配置失敗:', error);
        alert('系統錯誤，請重新整理');
    }
}

// ===== 渲染頁面 =====
function renderPage(config) {
    // 更新標題
    document.getElementById('gift-title').textContent = config.meta.title;
    document.getElementById('gift-subtitle').textContent = config.meta.subtitle;

    // 顯示對應的禮包選項
    updateAvailableGifts(config.gifts);
}

// ===== 顯示/隱藏禮包選項 =====
function updateAvailableGifts(allowedGifts) {
    const allGifts = ['efficiency', 'content', 'decision'];
    allGifts.forEach(gift => {
        const element = document.querySelector(`[data-gift-type="${gift}"]`);
        if (element) {
            if (allowedGifts.includes(gift)) {
                element.style.display = 'block';
            } else {
                element.style.display = 'none';
            }
        }
    });
}

// ===== 選擇禮包 =====
function selectGift(giftType) {
    currentGift = giftType;

    // 隱藏選擇頁面，顯示體驗頁面
    document.getElementById('select-page').classList.add('hidden');
    document.getElementById('experience-page').classList.remove('hidden');

    // 動態生成表單
    generateAllForms(giftType);

    trackEvent('gift_selected', { gift_type: giftType });
}

// ===== 動態生成所有提示詞的表單 =====
function generateAllForms(giftType) {
    const prompts = currentGiftConfig.prompts[giftType];
    if (!prompts) return;

    Object.keys(prompts).forEach((promptKey, index) => {
        const promptNum = index + 1;
        const promptConfig = prompts[promptKey];

        // 更新標題和場景
        document.querySelector(`#prompt-${promptNum} h3`).textContent = promptConfig.title;
        document.querySelector(`#prompt-${promptNum} .scenario`).innerHTML =
            `<strong>場景：</strong>${promptConfig.scenario}`;

        // 生成表單欄位
        const fieldsContainer = document.querySelector(`#prompt-${promptNum} .input-fields`);
        fieldsContainer.innerHTML = '';

        promptConfig.fields.forEach(field => {
            const formGroup = createFormField(field, promptNum);
            fieldsContainer.appendChild(formGroup);
        });
    });
}

// ===== 建立表單欄位 =====
function createFormField(fieldConfig, promptNum) {
    const div = document.createElement('div');
    div.className = 'input-group';

    const label = document.createElement('label');
    label.textContent = fieldConfig.label;
    div.appendChild(label);

    if (fieldConfig.type === 'select') {
        // 下拉選單
        const select = document.createElement('select');
        select.id = `input-${promptNum}-${fieldConfig.id}`;

        // 預設選項
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '請選擇...';
        select.appendChild(defaultOption);

        // 一般選項
        fieldConfig.options.forEach(option => {
            const opt = document.createElement('option');
            opt.value = option;
            opt.textContent = option;
            select.appendChild(opt);
        });

        div.appendChild(select);

        // 如果最後一個選項是「其他」，加入自訂輸入框
        if (fieldConfig.options[fieldConfig.options.length - 1] === '其他') {
            const customInput = document.createElement('input');
            customInput.type = 'text';
            customInput.id = `input-${promptNum}-${fieldConfig.id}-custom`;
            customInput.className = 'hidden custom-input';
            customInput.placeholder = '請輸入...';
            div.appendChild(customInput);

            // 監聽選單變化
            select.addEventListener('change', function() {
                if (this.value === '其他') {
                    customInput.classList.remove('hidden');
                    customInput.focus();
                } else {
                    customInput.classList.add('hidden');
                }
            });
        }
    } else if (fieldConfig.type === 'textarea') {
        // 文字區域
        const textarea = document.createElement('textarea');
        textarea.id = `input-${promptNum}-${fieldConfig.id}`;
        textarea.placeholder = fieldConfig.placeholder || '';
        div.appendChild(textarea);

        // 如果有範本按鈕，加入
        if (fieldConfig.templates && fieldConfig.templates.length > 0) {
            const templateDiv = document.createElement('div');
            templateDiv.style.marginTop = '10px';

            fieldConfig.templates.forEach(templateType => {
                const btn = document.createElement('button');
                btn.className = 'template-btn';
                btn.textContent = getTemplateName(templateType);
                btn.onclick = () => fillTemplate(templateType, promptNum, fieldConfig.id);
                templateDiv.appendChild(btn);
            });

            div.appendChild(templateDiv);
        }
    } else {
        // 一般輸入框
        const input = document.createElement('input');
        input.type = 'text';
        input.id = `input-${promptNum}-${fieldConfig.id}`;
        input.placeholder = fieldConfig.placeholder || '';
        div.appendChild(input);
    }

    return div;
}

// ===== 範本名稱對應 =====
function getTemplateName(templateType) {
    const names = {
        'ecommerce': '電商範例',
        'marketing': '行銷範例',
        'admin': '行政範例'
    };
    return names[templateType] || templateType;
}

// ===== 範本按鈕功能 =====
function fillTemplate(templateType, promptNum, fieldId) {
    const templates = {
        'ecommerce': '1. 每天檢查 5 個競品網站的價格變化\n2. 從後台匯出訂單資料，整理到 Excel 表格\n3. 回覆 10-20 封格式相似的客服問題',
        'marketing': '1. 每天發布 3 則社群貼文（FB、IG、LinkedIn）\n2. 從各平台匯出數據，整理成每週報表\n3. 追蹤 5 個競品的廣告投放和內容策略',
        'admin': '1. 審核員工的請假申請並更新系統\n2. 整理會議記錄，發送給參與者\n3. 更新專案進度到管理系統（Jira、Trello 等）'
    };

    const textarea = document.getElementById(`input-${promptNum}-${fieldId}`);
    if (textarea) {
        textarea.value = templates[templateType] || '';
    }
}

// ===== 生成提示詞 =====
function generatePrompt(promptNum) {
    const giftType = currentGift;
    const promptConfig = currentGiftConfig.prompts[giftType][`prompt${promptNum}`];
    let template = promptConfig.promptTemplate;

    // 取得所有欄位值
    promptConfig.fields.forEach(field => {
        let value = '';
        const element = document.getElementById(`input-${promptNum}-${field.id}`);

        if (!element) {
            console.error(`找不到元素: input-${promptNum}-${field.id}`);
            return;
        }

        if (field.type === 'select' && element.value === '其他') {
            // 使用自訂輸入的值
            const customInput = document.getElementById(`input-${promptNum}-${field.id}-custom`);
            value = customInput ? customInput.value : '';
        } else {
            value = element.value;
        }

        // 如果沒有填值，使用 placeholder 或預設文字
        if (!value || value.trim() === '') {
            value = field.placeholder || '請填寫';
        }

        // 替換模板變數
        template = template.replace(new RegExp(`\\{${field.id}\\}`, 'g'), value);
    });

    // 顯示結果
    document.getElementById(`prompt-${promptNum}-text`).textContent = template;
    document.getElementById(`result-${promptNum}`).classList.remove('hidden');
    document.getElementById(`hint-${promptNum}`).classList.remove('hidden');

    // 更新進度
    completedPrompts = Math.max(completedPrompts, promptNum);
    updateProgress();

    // 第一個提示詞完成後顯示 Email Gate
    if (promptNum === 1) {
        setTimeout(() => {
            const emailGate = document.getElementById('email-gate-1');
            if (emailGate) {
                emailGate.classList.remove('hidden');
                emailGate.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            }
        }, 500);
    }

    // 第二個提示詞完成後顯示「解鎖第三個」按鈕
    if (promptNum === 2) {
        setTimeout(() => {
            const nextBtn = document.getElementById('next-2');
            if (nextBtn) {
                nextBtn.classList.remove('hidden');
            }
        }, 500);
    }

    // 第三個提示詞完成後顯示「完成」按鈕
    if (promptNum === 3) {
        setTimeout(() => {
            const completeBtn = document.getElementById('complete-btn');
            if (completeBtn) {
                completeBtn.classList.remove('hidden');
            }
        }, 500);
    }

    trackEvent('prompt_generated', {
        gift_type: giftType,
        prompt_num: promptNum
    });
}

// ===== 複製提示詞 =====
function copyPrompt(promptNum) {
    const promptText = document.getElementById(`prompt-${promptNum}-text`).textContent;
    const btn = event.target;

    navigator.clipboard.writeText(promptText).then(() => {
        const originalText = btn.textContent;
        btn.textContent = '已複製!';
        btn.classList.add('copied');

        setTimeout(() => {
            btn.textContent = originalText;
            btn.classList.remove('copied');
        }, 2000);

        trackEvent('prompt_copied', {
            gift_type: currentGift,
            prompt_num: promptNum
        });
    }).catch(err => {
        console.error('複製失敗:', err);
        alert('複製失敗，請手動選取文字複製');
    });
}

// ===== 提交 Email =====
function submitEmail() {
    const email = document.getElementById('user-email').value.trim();
    const errorDiv = document.getElementById('email-error');

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
        errorDiv.classList.remove('hidden');
        return;
    }

    errorDiv.classList.add('hidden');
    userEmail = email;

    // 隱藏 Email Gate，顯示第二個提示詞
    document.getElementById('email-gate-1').classList.add('hidden');
    showPrompt(2);

    // 提交到後端
    submitToBackend(email);

    trackEvent('email_submitted', {
        email: email,
        gift_type: currentGift,
        completed_prompts: completedPrompts
    });
}

// ===== 顯示下一個提示詞 =====
function showPrompt(promptNum) {
    const promptElement = document.getElementById(`prompt-${promptNum}`);
    if (promptElement) {
        promptElement.classList.remove('hidden');

        setTimeout(() => {
            promptElement.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }, 100);
    }
}

// ===== 更新進度條 =====
function updateProgress() {
    const percentage = (completedPrompts / 3) * 100;
    const progressFill = document.getElementById('progress-fill');
    const progressNum = document.getElementById('progress-num');

    if (progressFill) {
        progressFill.style.width = percentage + '%';
    }
    if (progressNum) {
        progressNum.textContent = completedPrompts;
    }
}

// ===== 顯示過期頁面 =====
function showExpired() {
    document.body.innerHTML = `
        <div class="container">
            <div class="card" style="text-align: center; padding: 60px 20px;">
                <div style="font-size: 4em; margin-bottom: 20px;">⏰</div>
                <h1>此禮包已過期</h1>
                <p class="subtitle" style="margin: 20px 0;">限量已領完，敬請期待下次活動！</p>
                <a href="https://thinker.cafe/products" class="btn">查看所有課程</a>
            </div>
        </div>
    `;
}

// ===== 顯示完成頁面 =====
function goToCompletion() {
    document.getElementById('experience-page').classList.add('hidden');
    document.getElementById('completion-page').classList.remove('hidden');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    trackEvent('all_prompts_completed', {
        gift_type: currentGift,
        email: userEmail
    });
}

// ===== 後端提交 =====
async function submitToBackend(email) {
    const data = {
        email: email,
        gift_type: currentGift,
        completed_prompts: completedPrompts,
        password: localStorage.getItem('gift_password'),
        source: currentGiftConfig ? currentGiftConfig.meta.source : 'unknown'
    };

    console.log('📤 提交數據:', data);

    try {
        const response = await fetch('/api/gift-leads', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (response.ok) {
            console.log('✅ Email 提交成功:', result);

            // Show success message (optional)
            if (result.already_exists) {
                console.log('ℹ️ 此 Email 已經登記過此禮包');
            }
        } else {
            console.error('❌ Email 提交失敗:', result);
            // Don't block user experience even if backend fails
        }
    } catch (error) {
        console.error('❌ 提交錯誤:', error);
        // Don't block user experience even if backend fails
    }
}

// ===== 事件追蹤 =====
function trackEvent(eventName, data) {
    console.log('追蹤事件:', eventName, data);

    // Google Analytics 4
    if (typeof gtag !== 'undefined') {
        gtag('event', eventName, data);
    }

    // 也可以發送到你自己的後端
    // fetch('/api/track', { method: 'POST', body: JSON.stringify({ event: eventName, data }) });
}

// ===== 頁面載入完成 =====
window.addEventListener('load', function() {
    // 只在禮包頁面（非驗證頁面）初始化
    if (typeof initGiftPage === 'function' && !document.getElementById('verify-page')) {
        initGiftPage();
    }

    trackEvent('page_loaded', {
        timestamp: new Date().toISOString(),
        referrer: document.referrer
    });
});

// ===== 離開頁面追蹤 =====
window.addEventListener('beforeunload', function() {
    if (completedPrompts > 0 && !userEmail) {
        // 用戶生成了提示詞但沒留 email
        trackEvent('exit_without_email', {
            gift_type: currentGift,
            completed_prompts: completedPrompts
        });
    }
});
