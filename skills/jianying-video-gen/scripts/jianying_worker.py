"""
小云雀 (Jianying) 自动化视频生成 v5
引擎: Playwright + Chromium
支持: 文生视频 (T2V) + 参考视频生成 (V2V)
"""
import asyncio
import json
import re
import os
import html
import argparse
from playwright.async_api import async_playwright

COOKIES_FILE = 'cookies.json'  # 可通过 --cookies 覆盖
DOWNLOAD_DIR = '.'  # 可通过 --output-dir 覆盖

def load_and_clean_cookies():
    with open(COOKIES_FILE, 'r') as f:
        raw = json.load(f)
    cleaned = []
    allowed = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure']
    for c in raw:
        clean = {}
        for key in allowed:
            if key == 'expires':
                val = c.get('expirationDate') or c.get('expires')
                if val is not None:
                    clean['expires'] = val
                continue
            if key in c and c[key] is not None:
                clean[key] = c[key]
        cleaned.append(clean)
    return cleaned

DEBUG_SCREENSHOTS = False  # 由 --dry-run 控制

async def screenshot(page, name):
    if not DEBUG_SCREENSHOTS:
        return
    path = os.path.join(DOWNLOAD_DIR, f'step_{name}.png')
    await page.screenshot(path=path)
    print(f"  📸 Screenshot: {path}")

async def safe_click(page, locator_or_selector, label, timeout=5000):
    """用 Playwright locator.click() 点击元素，模拟真实鼠标事件"""
    try:
        if isinstance(locator_or_selector, str):
            loc = page.locator(locator_or_selector).first
        else:
            loc = locator_or_selector
        await loc.click(timeout=timeout)
        print(f"  ✅ {label}: clicked")
        return True
    except Exception as e:
        print(f"  ❌ {label}: {e}")
        return False

async def run(prompt: str, duration: str = "10s", ratio: str = "横屏", model: str = "Seedance 2.0", dry_run: bool = False, ref_video: str = None, ref_image: str = None):
    global DEBUG_SCREENSHOTS
    DEBUG_SCREENSHOTS = dry_run
    if ref_image:
        mode_label = "I2V (图生视频)"
    elif ref_video:
        mode_label = "V2V (参考视频)"
    else:
        mode_label = "T2V (文生视频)"
    print(f"🚀 Starting Playwright + Chromium (headless)... [{mode_label}]")
    if ref_video and not os.path.exists(ref_video):
        print(f"❌ 参考视频文件不存在: {ref_video}")
        return
    if ref_image and not os.path.exists(ref_image):
        print(f"❌ 参考图片文件不存在: {ref_image}")
        return
    if ref_video:
        size_mb = os.path.getsize(ref_video) / (1024 * 1024)
        print(f"📎 参考视频: {ref_video} ({size_mb:.1f}MB)")
    if ref_image:
        size_kb = os.path.getsize(ref_image) / 1024
        print(f"🖼️ 参考图片: {ref_image} ({size_kb:.0f}KB)")
    if dry_run:
        print("⚠️ DRY-RUN MODE: will fill form but NOT click '开始创作'")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-setuid-sandbox']
        )
        context = await browser.new_context(
            viewport={'width': 1920, 'height': 1080}
        )

        # === Step 1: Cookie 注入 ===
        print("🔑 [Step 1] Injecting cookies...")
        cookies = load_and_clean_cookies()
        await context.add_cookies(cookies)
        print(f"  ✅ {len(cookies)} cookies injected")

        page = await context.new_page()

        # === Step 2: 导航 ===
        print("🌐 [Step 2] Navigating to xyq.jianying.com/home...")
        await page.goto('https://xyq.jianying.com/home', wait_until='domcontentloaded')
        await page.wait_for_timeout(8000)
        await screenshot(page, '2_loaded')

        # === Step 3: 登录验证 ===
        print("🔍 [Step 3] Checking login status...")
        content = await page.content()
        is_logged_in = '开始创作' in content or '登录' not in content
        if is_logged_in:
            print("  ✅ LOGIN_SUCCESS")
        else:
            print("  ❌ LOGIN_FAILED — 请重新导出 cookies.json！")
            await browser.close()
            return

        # === Step 3.5: 点击 "+ 新建" ===
        # 使用 Playwright locator 精确匹配左上角的按钮
        print("🆕 [Step 3.5] Clicking '+ 新建'...")
        await safe_click(page, page.locator('text=新建').first, '新建')
        await page.wait_for_timeout(3000)
        await screenshot(page, '3_5_new_page')

        # === Step 3.6: 上传参考图片 (仅 I2V 模式) ===
        if ref_image:
            print(f"🖼️ [Step 3.6] Uploading reference image: {os.path.basename(ref_image)}")

            # 点击输入区域的 "+" 按钮 (工具栏最左边)
            # 点击输入区域的 "+" 按钮 (包含 lucide-plus SVG，在 "模式" 左侧)
            # DOM 结构显示它和 "模式" 都在 .configButtons 容器内
            plus_clicked = False
            try:
                # 寻找包含 "模式" 文本最近的祖先，且内部有 lucide-plus 图标的按钮
                plus_locator = page.locator('div:has(> div > span:text("模式"))').locator('..').locator('button:has(svg.lucide-plus), div[class*="uploadContainer"] button').first
                
                box = await plus_locator.bounding_box()
                if not box:
                    # 备用方案：全局找 lucide-plus 但在 toolbar 区域内
                    plus_locator = page.locator('button:has(svg.lucide-plus)').first
                    
                await plus_locator.click(timeout=3000)
                plus_clicked = True
                print(f"  + 按钮: OK (Playwright locator)")
            except Exception as e:
                print(f"  + 按钮: locator_fail ({e})")
                
            if not plus_clicked:
                # 最后的 evaluate 兜底方案
                plus_result = await page.evaluate('''() => {
                    const svgs = Array.from(document.querySelectorAll('svg.lucide-plus'));
                    const targetSvg = svgs.find(svg => {
                        const r = svg.getBoundingClientRect();
                        return r.top > 300 && r.top < 600 && r.left > 400 && r.left < 800;
                    });
                    if (targetSvg) {
                        const btn = targetSvg.closest('button') || targetSvg.parentElement;
                        btn.click();
                        return 'OK_EVAL (svg.lucide-plus found)';
                    }
                    return 'NOT_FOUND';
                }''')
                print(f"  + 按钮: eval fallback -> {plus_result}")
                plus_clicked = plus_result.startswith('OK')
            await page.wait_for_timeout(2000)
            await screenshot(page, '3_6_plus_menu')

            if plus_clicked:
                # 点击 "本地上传" 并上传图片
                try:
                    async with page.expect_file_chooser(timeout=10000) as fc_info:
                        upload_clicked = await page.evaluate('''() => {
                            const all = Array.from(document.querySelectorAll('*'));
                            const candidates = all.filter(el => {
                                const text = el.innerText && el.innerText.trim();
                                if (!text) return false;
                                return text === '本地上传' || text === '从本地上传';
                            });
                            candidates.sort((a, b) => {
                                return (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight);
                            });
                            if (candidates.length > 0) {
                                const el = candidates[0];
                                el.click();
                                return 'OK: ' + el.tagName;
                            }
                            return 'NOT_FOUND';
                        }''')
                        print(f"  本地上传: {upload_clicked}")
                        if upload_clicked == 'NOT_FOUND':
                            raise Exception("'本地上传' not found in menu")

                    file_chooser = await fc_info.value
                    await file_chooser.set_files(ref_image)
                    print(f"  ✅ 图片已选择: {os.path.basename(ref_image)}")

                    # 等待图片上传完成 (检测缩略图出现)
                    print("  ⏳ 等待图片上传...")
                    for wait_i in range(30):
                        await page.wait_for_timeout(3000)
                        has_image = await page.evaluate('''() => {
                            const container = document.querySelector('div[class*="inputContainer"]');
                            if (!container) return false;
                            return container.querySelector('img') !== null;
                        }''')
                        if has_image:
                            print(f"  ✅ 图片上传完成 (elapsed: {(wait_i+1)*3}s)")
                            break
                        if wait_i > 0 and wait_i % 5 == 0:
                            print(f"    ⏳ 等待中... ({(wait_i+1)*3}s)")
                            
                    # 点击空白处关闭任何弹出的菜单
                    await page.mouse.click(0, 0)

                except Exception as e:
                    print(f"  ❌ 图片上传失败: {e}")

            await page.wait_for_timeout(2000)
            await screenshot(page, '3_6_image_uploaded')

        # === Step 4: 选模式 "沉浸式短片" ===
        # 关键: 用 Playwright locator.click() 而不是 JS .click()
        # 因为 React 事件系统只响应真实 DOM 事件
        print("🎬 [Step 4] Selecting mode: 沉浸式短片...")

        # 4a: 点击 "模式" 下拉按钮（在工具栏里，用 text= 匹配）
        mode_opened = await safe_click(page, page.locator('text=模式').nth(0), '模式下拉')
        await page.wait_for_timeout(2000)
        await screenshot(page, '4a_dropdown')

        if mode_opened:
            # 4b: 在下拉菜单中点击 "沉浸式短片"
            # 下拉菜单中有三个选项：沉浸式短片、智能长视频、图片
            # 需要精确点击菜单项，避免点到左侧边栏
            # 策略：用 text= 匹配，但限定区域 (排除左侧 sidebar x<220)
            mode_selected = await page.evaluate('''() => {
                const items = Array.from(document.querySelectorAll('*'));
                // 找到所有包含"沉浸式短片"的元素
                const candidates = items.filter(el => {
                    const text = el.innerText && el.innerText.trim();
                    return text === '沉浸式短片' && el.offsetHeight < 50 && el.offsetHeight > 10;
                });
                // 按x坐标排序，优先选择靠近中间的（下拉菜单的位置）
                candidates.sort((a, b) => {
                    const ra = a.getBoundingClientRect();
                    const rb = b.getBoundingClientRect();
                    return rb.left - ra.left; // 先取 x 最大的
                });
                for (const el of candidates) {
                    const rect = el.getBoundingClientRect();
                    if (rect.left > 300) {
                        // 通过 dispatchEvent 模拟完整的鼠标事件链
                        el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
                        el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true}));
                        el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
                        return 'selected (x=' + Math.round(rect.left) + ', y=' + Math.round(rect.top) + ')';
                    }
                }
                // 返回调试信息
                return 'NOT_FOUND: candidates=' + candidates.map(el => {
                    const r = el.getBoundingClientRect();
                    return '(' + Math.round(r.left) + ',' + Math.round(r.top) + ')';
                }).join(';');
            }''')
            print(f"  沉浸式短片: {mode_selected}")
            await page.wait_for_timeout(3000)
        await screenshot(page, '4b_mode_selected')

        # === Step 5: 选模型 ===
        print(f"🤖 [Step 5] Selecting model: {model}...")

        # 5a: 精确点击工具栏的 "2.0 Fast" 按钮
        # 关键约束: text.length < 15 排除匹配到整个工具栏容器
        model_click = await page.evaluate('''() => {
            const items = Array.from(document.querySelectorAll('*'));
            const btn = items.find(el => {
                const text = el.innerText && el.innerText.trim();
                if (!text || !text.includes('2.0')) return false;
                // 关键: 文本长度 < 15，只匹配 "2.0 Fast" 这样的短文本
                // 排除整个工具栏容器 ("沉浸式短片\\n2.0 Fast\\n参考\\n5s")
                if (text.length > 15) return false;
                const rect = el.getBoundingClientRect();
                // 工具栏区域: y > 370, x > 600, 小元素
                return rect.top > 370 && rect.left > 600 && el.offsetHeight < 50 && el.offsetHeight > 15;
            });
            if (btn) {
                btn.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
                btn.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true}));
                btn.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
                const r = btn.getBoundingClientRect();
                return 'opened: ' + btn.innerText.trim() + ' (x=' + Math.round(r.left) + ', y=' + Math.round(r.top) + ')';
            }
            return 'NOT_FOUND';
        }''')
        print(f"  Model button: {model_click}")
        await page.wait_for_timeout(2000)
        await screenshot(page, '5a_model_dropdown')

        if 'opened' in model_click:
            # 5b: 在下拉菜单中选目标模型
            # 下拉结构:
            #   "Seedance 2.0 Fast" (标题) + "更快更便宜的Seedance 2.0模型" (描述)
            #   "Seedance 2.0" (标题) + "15 秒内效果无损..." (描述)
            #   "Seedance 1.5" (标题) + "画面直出..." (描述)
            # 关键: 标题行是纯英文/数字/空格/点，描述行含中文
            model_select = await page.evaluate('''([wantFast]) => {
                const items = Array.from(document.querySelectorAll('*'));
                const candidates = items.filter(el => {
                    const text = el.innerText && el.innerText.trim();
                    if (!text) return false;
                    // 只匹配纯英文+数字+空格+点的标题行，排除含中文的描述行
                    if (!/^Seedance\s+\d/.test(text)) return false;
                    // 不能含中文字符
                    if (/[\u4e00-\u9fff]/.test(text)) return false;
                    if (el.offsetHeight > 40 || el.offsetHeight < 10) return false;
                    const rect = el.getBoundingClientRect();
                    return rect.left > 300 && rect.left < 1100 && rect.top > 400;
                });
                for (const el of candidates) {
                    const text = el.innerText.trim();
                    const isFast = text.includes('Fast');
                    if (wantFast === isFast) {
                        el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
                        el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true}));
                        el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
                        const r = el.getBoundingClientRect();
                        return 'selected: ' + text + ' (x=' + Math.round(r.left) + ', y=' + Math.round(r.top) + ')';
                    }
                }
                return 'NOT_FOUND: candidates=' + candidates.map(el => {
                    const r = el.getBoundingClientRect();
                    return '"' + el.innerText.trim() + '"(x=' + Math.round(r.left) + ',y=' + Math.round(r.top) + ')';
                }).join('; ');
            }''', ["Fast" in model])
            print(f"  Model select: {model_select}")
            await page.wait_for_timeout(1500)
        await screenshot(page, '5b_model_selected')

        # === Step 6: 上传参考视频 (仅 V2V 模式) ===
        if ref_video:
            print(f"📎 [Step 6] Uploading reference video: {os.path.basename(ref_video)}")

            # 6a: 点击工具栏的 "参考" 按钮 → 弹出面板
            # "参考" 文字可能在多处出现，用坐标限制到工具栏区域 (y>370)
            ref_click_result = await page.evaluate('''() => {
                const items = Array.from(document.querySelectorAll('*'));
                const btn = items.find(el => {
                    const text = el.innerText && el.innerText.trim();
                    if (text !== '参考') return false;
                    const rect = el.getBoundingClientRect();
                    // 工具栏区域: y > 370, 小元素
                    return rect.top > 370 && el.offsetHeight < 50 && el.offsetHeight > 10;
                });
                if (btn) {
                    btn.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
                    btn.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true}));
                    btn.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
                    const r = btn.getBoundingClientRect();
                    return 'OK (x=' + Math.round(r.left) + ', y=' + Math.round(r.top) + ')';
                }
                return 'NOT_FOUND';
            }''')
            ref_clicked = 'OK' in ref_click_result
            print(f"  参考按钮: {ref_click_result}")
            await page.wait_for_timeout(3000)
            await screenshot(page, '6a_ref_panel')

            if ref_clicked:
                # 6b: 在弹出面板中点击 "从本地上传" 链接
                # 面板结构:
                #   输入框: "请输入参考内容链接或从本地上传"
                #   描述: "仅支持抖音、头条、西瓜，你也可以 [从本地上传]"  ← 紫色链接
                #   按钮: [确认]
                try:
                    async with page.expect_file_chooser(timeout=10000) as fc_info:
                        # 精确点击 "从本地上传" 链接 (紫色文字，在描述行中)
                        upload_clicked = await page.evaluate('''() => {
                            // 方式1: 找精确匹配 "从本地上传" 的元素 (最小的那个，即链接本身)
                            const all = Array.from(document.querySelectorAll('*'));
                            const candidates = all.filter(el => {
                                const text = el.innerText && el.innerText.trim();
                                if (!text) return false;
                                // 精确匹配: 文本就是 "从本地上传" (不含其他文字)
                                if (text === '从本地上传') return true;
                                return false;
                            });
                            // 按元素大小排序，取最小的 (最精确的)
                            candidates.sort((a, b) => {
                                return (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight);
                            });
                            if (candidates.length > 0) {
                                const el = candidates[0];
                                el.click();
                                return 'OK_link: ' + el.tagName;
                            }
                            return 'NOT_FOUND';
                        }''')
                        print(f"  从本地上传: {upload_clicked}")
                        if upload_clicked == 'NOT_FOUND':
                            raise Exception("'从本地上传' link not found in popup")

                    file_chooser = await fc_info.value
                    await file_chooser.set_files(ref_video)
                    print(f"  ✅ 文件已选择: {os.path.basename(ref_video)}")

                    # 等待上传: 弹窗会显示上传进度，完成后弹窗关闭，页面出现缩略图
                    print("  ⏳ 等待上传完成...")
                    for wait_i in range(60):  # 最多等 300 秒
                        await page.wait_for_timeout(5000)

                        upload_status = await page.evaluate('''() => {
                            // 检测1: 弹窗是否还在 (如果弹窗关闭了大概率上传完成)
                            const popup = document.querySelector('[class*="modal"], [class*="dialog"], [role="dialog"]');
                            const hasConfirmBtn = !!Array.from(document.querySelectorAll('*')).find(el =>
                                el.innerText && el.innerText.trim() === '确认' &&
                                el.offsetHeight < 50 && el.offsetHeight > 15
                            );

                            // 检测2: 视频缩略图元素是否出现 (带 video 标签或 img)
                            const inputArea = document.querySelector('div[contenteditable="true"]');
                            const hasThumb = inputArea ?
                                (inputArea.parentElement.querySelector('video') !== null ||
                                 inputArea.parentElement.querySelector('img[src*="tos"]') !== null) :
                                false;

                            // 检测3: 是否有上传进度指示
                            const html = document.body.innerHTML;
                            const isUploading = html.includes('上传中') || html.includes('uploading');

                            if (hasThumb) return 'DONE';
                            if (isUploading) return 'UPLOADING';
                            if (!hasConfirmBtn && !popup) return 'POPUP_CLOSED';
                            return 'WAITING';
                        }''')

                        if upload_status == 'DONE':
                            print(f"  ✅ 上传完成! 缩略图已出现 (elapsed: {(wait_i+1)*5}s)")
                            break
                        elif upload_status == 'POPUP_CLOSED':
                            print(f"  ✅ 弹窗已关闭 (elapsed: {(wait_i+1)*5}s)")
                            break
                        elif upload_status == 'UPLOADING':
                            print(f"    ⏳ 上传中... ({(wait_i+1)*5}s)")
                        elif wait_i > 0 and wait_i % 6 == 0:
                            print(f"    ⏳ 等待中... ({(wait_i+1)*5}s)")

                    # 如果弹窗还开着，尝试关闭 (点 X 按钮)
                    await page.evaluate('''() => {
                        // 找 X 关闭按钮
                        const closeBtn = document.querySelector('[class*="close"], [aria-label="close"], [aria-label="关闭"]');
                        if (closeBtn) { closeBtn.click(); return; }
                        // 找确认按钮
                        const all = Array.from(document.querySelectorAll('*'));
                        const confirm = all.find(el => el.innerText && el.innerText.trim() === '确认'
                            && el.offsetHeight < 50 && el.offsetHeight > 15);
                        if (confirm) confirm.click();
                    }''')
                    await page.wait_for_timeout(2000)

                except Exception as e:
                    print(f"  ❌ 参考视频上传失败: {e}")

            await page.wait_for_timeout(2000)
            await screenshot(page, '6b_ref_uploaded')

        # === Step 7: 选时长 ===
        step7_label = '7' if ref_video else '6'
        print(f"⏱️ [Step {step7_label}] Selecting duration: {duration}...")
        
        # 点击当前时长按钮 (显示 "5s"、"10s" 或 "15s")
        dur_btn = page.locator('text=/^\\d+s$/').first
        dur_opened = await safe_click(page, dur_btn, '时长按钮')
        await page.wait_for_timeout(1500)
        await screenshot(page, f'{step7_label}a_duration_dropdown')

        if dur_opened:
            try:
                dur_item = page.locator(f'text=/^{duration}$/').first
                await dur_item.click(timeout=3000)
                print(f"  ✅ 时长选择: {duration}")
            except Exception as e:
                print(f"  ⚠️ 时长选择: {e}")
            await page.wait_for_timeout(1000)
        await screenshot(page, f'{step7_label}b_duration_selected')

        # === Step 8: 注入 Prompt ===
        step8_label = '8' if ref_video else '7'
        print(f"📝 [Step {step8_label}] Injecting prompt: {prompt}")
        inject_result = await page.evaluate('''([text]) => {
            const el = document.querySelector('div[contenteditable="true"]');
            if (el) {
                el.innerText = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                return 'OK: ' + el.innerText.substring(0, 30) + '...';
            }
            return 'FAILED: no contenteditable found';
        }''', [prompt])
        print(f"  Inject: {inject_result}")
        await page.wait_for_timeout(1000)
        await screenshot(page, f'{step8_label}_prompt')

        # === Step 8: 验证/提交 ===
        if dry_run:
            await screenshot(page, '8_DRY_RUN_FINAL')
            status_text = await page.evaluate('''() => {
                const all = Array.from(document.querySelectorAll('*'));
                const info = all.find(el => {
                    const t = el.innerText && el.innerText.trim();
                    return t && t.includes('积分') && t.includes('秒') && el.offsetHeight < 40;
                });
                return info ? info.innerText.trim() : 'NOT_FOUND';
            }''')
            print(f"\n✅ DRY-RUN 完成！请检查截图 step_8_DRY_RUN_FINAL.png")
            print(f"📊 底部状态栏: {status_text}")
            print(f"\n确认无误后，去掉 --dry-run 参数重新运行即可提交任务。")
            await browser.close()
            return

        # === Step 8: 设置 thread_id 拦截器 + 提交 ===
        thread_id = None
        async def sniff_thread(response):
            nonlocal thread_id
            if thread_id:
                return
            try:
                text = await response.text()
                if 'thread_id' in text:
                    import json as _json
                    # 尝试从 JSON 中提取 thread_id
                    data = _json.loads(text)
                    # thread_id 可能在不同层级
                    tid = None
                    if isinstance(data, dict):
                        tid = data.get('thread_id') or data.get('data', {}).get('thread_id')
                        if not tid and 'data' in data:
                            d = data['data']
                            if isinstance(d, dict):
                                tid = d.get('thread_id')
                                # 可能嵌套更深
                                for v in d.values():
                                    if isinstance(v, dict) and 'thread_id' in v:
                                        tid = v['thread_id']
                                        break
                    if not tid:
                        # 暴力正则
                        m = re.search(r'"thread_id"\s*:\s*"([^"]+)"', text)
                        if m:
                            tid = m.group(1)
                    if tid:
                        thread_id = tid
                        print(f"\n  🎯 Sniffed thread_id: {tid}")
            except Exception:
                pass

        page.on('response', sniff_thread)

        print("🖱️ [Step 8] Clicking '开始创作'...")
        submit_clicked = await safe_click(page, page.locator('text=开始创作').first, '开始创作')
        await page.wait_for_timeout(5000)
        await screenshot(page, '8_submitted')

        if not submit_clicked:
            print("  ❌ Submit failed. Aborting.")
            await browser.close()
            return

        # 等待 thread_id 被拦截
        for _ in range(10):
            if thread_id:
                break
            await page.wait_for_timeout(2000)

        if not thread_id:
            print("  ⚠️ thread_id not captured from responses, trying page HTML...")
            page_html = await page.content()
            m = re.search(r'thread_id["\s:=]+([0-9a-f-]{36})', page_html)
            if m:
                thread_id = m.group(1)
                print(f"  🎯 Found thread_id in HTML: {thread_id}")

        if not thread_id:
            print("  ❌ Could not get thread_id. Aborting.")
            await browser.close()
            return

        # === Step 9: 导航到 thread 详情页 + 轮询视频 ===
        detail_url = f"https://xyq.jianying.com/home?tab_name=integrated-agent&thread_id={thread_id}"
        print(f"🔗 [Step 9] Navigating to thread detail page...")
        print(f"  URL: {detail_url}")
        await page.goto(detail_url, wait_until='domcontentloaded')
        await page.wait_for_timeout(8000)

        safe_name = ''.join(c for c in prompt[:15] if c.isalnum() or c in '_ ')
        filename = f"{safe_name}_{duration}.mp4"
        filepath = os.path.join(DOWNLOAD_DIR, filename)

        print("⏳ Polling for video on detail page...")
        mp4_url = None
        for i in range(120):
            await page.wait_for_timeout(5000)

            # 双通道提取: DOM + 正则
            mp4_url = await page.evaluate('''() => {
                // 通道1: <video> 标签 src
                const v = document.querySelector('video');
                if (v && v.src && v.src.includes('.mp4')) return v.src;
                const s = document.querySelector('video source');
                if (s && s.src && s.src.includes('.mp4')) return s.src;
                // 通道2: 暴力正则
                const html = document.documentElement.innerHTML;
                const m = html.match(/https?:\/\/[^"'\\s\\\\]+\.mp4[^"'\\s\\\\]*/);
                return m ? m[0] : null;
            }''')

            if mp4_url:
                mp4_url = html.unescape(mp4_url)
                print(f"\n  🎉 Found MP4 at attempt {i+1}!")
                print(f"  🔗 {mp4_url[:120]}...")
                break

            if i % 12 == 0 and i > 0:
                print(f"  ⏳ Still generating... ({i*5}s elapsed)")
                # 刷新详情页
                await page.reload(wait_until='domcontentloaded')
                await page.wait_for_timeout(5000)
            print(".", end="", flush=True)

        if not mp4_url:
            print("\n  ❌ Timeout after 10 min")
            await screenshot(page, '9_timeout')
            await browser.close()
            return

        await screenshot(page, '9_video_ready')

        # === Step 10: curl 下载 ===
        print(f"📥 [Step 10] Downloading to {filepath}...")
        import subprocess
        result = subprocess.run(
            ['curl', '-L', '-o', filepath, '-s', '-w', '%{http_code}', mp4_url],
            capture_output=True, text=True, timeout=120
        )
        http_code = result.stdout.strip()

        if os.path.exists(filepath) and os.path.getsize(filepath) > 10000:
            size_mb = os.path.getsize(filepath) / (1024 * 1024)
            print(f"  ✅ Saved: {os.path.abspath(filepath)} ({size_mb:.1f}MB) [HTTP {http_code}]")
        else:
            print(f"  ❌ Download failed: HTTP {http_code}")
            if result.stderr:
                print(f"  Error: {result.stderr[:200]}")
            print(f"  📋 Manual link: {mp4_url}")

        await browser.close()

    print("\n🏁 Done!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Jianying SeeDance 2.0 Video Generator")
    parser.add_argument("--prompt", type=str, default="一个美女在跳舞", help="Video description")
    parser.add_argument("--duration", type=str, default="10s", choices=["5s", "10s", "15s"])
    parser.add_argument("--ratio", type=str, default="横屏", choices=["横屏", "竖屏", "方屏"])
    parser.add_argument("--model", type=str, default="Seedance 2.0",
                        choices=["Seedance 2.0", "Seedance 2.0 Fast"])
    parser.add_argument("--ref-video", type=str, default=None, help="Reference video file path (V2V mode)")
    parser.add_argument("--ref-image", type=str, default=None, help="Reference image file path (I2V mode)")
    parser.add_argument("--cookies", type=str, default="cookies.json", help="Path to cookies.json")
    parser.add_argument("--output-dir", type=str, default=".", help="Directory to save output video")
    parser.add_argument("--dry-run", action="store_true", help="Only fill form, don't submit")
    args = parser.parse_args()

    COOKIES_FILE = args.cookies
    DOWNLOAD_DIR = args.output_dir
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)

    if not os.path.exists(COOKIES_FILE):
        print(f"⚠️ {COOKIES_FILE} not found!")
    else:
        asyncio.run(run(args.prompt, args.duration, args.ratio, args.model, args.dry_run, args.ref_video, args.ref_image))
