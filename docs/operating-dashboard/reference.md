# reference

## 当前目标

MoClaw Operating Dashboard 第一版交付以 `docs/build_operating_dashboard_web.py` 为主生成器，输出静态 HTML：

- `docs/MoClaw_Operating_Dashboard_Web.html`
- `docs/MoClaw_Operating_Dashboard_Web_home.html`

这份 reference 记录当前信息架构、评论能力、数据源、验证命令和接入 maxx.center 的接口约定。

## 第一版信息架构

当前交付版本包含 8 个 tab：

1. `Dashboard`
2. `用户获取`
3. `用户激活与转化`
4. `用户活跃与使用分布`
5. `Agent & 工程质量`
6. `业务经营`
7. `口径字典`
8. `附录2 个人看板反馈`

已确认口径：

- `新增 freetrial 用户`：当日创建 freetrial subscription 的去重用户数。
- `freetrial 率`：新增 freetrial 用户 / 新增注册用户。
- `新访 DAU`：D0 新增 freetrial 用户中，D0 发过至少一条 `chat:message_sent` 的去重用户数。
- `开口率`：新访 DAU / 新增 freetrial 用户。
- `新增 DAU`：只在全量活跃上下文使用，表示全量产品首次发消息用户。
- `截至当日已取消/结束订阅数`：截至当日累计取消/结束 subscription stock，不是当日新增取消 flow。

## 数据源

生成器读取源工作簿并叠加本地刷新出来的指标文件，最终以生成脚本中的字段定义、tooltip 和 `口径字典` 附录为准。

| 数据源 | 覆盖指标 | 当前文件 / 来源 | 注意事项 |
| --- | --- | --- | --- |
| PostHog 产品事件 | 新增 UV、注册、freetrial、D0 开口、留存、活跃、文件/Connector/能力采纳、checkout funnel | `generated_posthog_metrics/posthog_*.csv` | 由 `pull_operating_dashboard_generated_metrics.py` 拉取和派生；用户类指标默认按 person 去重，事件类指标按 event 次数。 |
| Stripe / finance 派生表 | 现金收入、净现金收入、MRR、订阅状态、D+3 扣款、取消/结束订阅数 | `generated_posthog_metrics/calc_finance_2026-05-15_2026-05-26.csv` | 取消/结束订阅数是累计 stock。 |
| Google Ads | 广告花费、展示、点击、付费获客成本、CAC | `generated_posthog_metrics/google_ads_daily_2026-05-15_2026-05-26.csv` | 当前已接 Google Ads；Meta / KOC 等未完整映射时保留为空或待映射。 |
| Grafana / AI Gateway | AI Gateway 请求、错误、token/credits、模型/provider 分布、沙盒与入口安全指标 | `generated_posthog_metrics/grafana_*.csv` / `generated_posthog_metrics/grafana_*.json` | 工程质量类指标按监控源聚合，和 PostHog 用户事件不能直接相加。 |
| 源工作簿 | 原始表结构、历史字段、个人看板反馈和人工补充上下文 | `web_restore_sources/JJHV_MoClaw_Dashboard_v31.xlsx` | 生成器读取源工作簿后重建正式信息架构。 |

## 评论能力

评论系统已作为独立模块接入主生成器，不覆盖业务表结构。

文件：

- `docs/dashboard_comments/comment_model.js`
- `docs/dashboard_comments/comment_store.js`
- `docs/dashboard_comments/comment_overlay.js`
- `docs/dashboard_comments/comment_overlay.css`
- `docs/dashboard_comments/API_CONTRACT.md`
- `docs/dashboard_comments/playwright_comment_smoke.mjs`
- `docs/test_dashboard_comment_anchors.py`

前端行为：

- 右下角悬浮按钮进入评论模式。
- 点击 sheet / section / row / cell 的语义 anchor 创建评论。
- 评论气泡覆盖在表格上，不写进单元格。
- 横向滚动、tab 切换、展开收起后重新定位气泡。
- 默认使用 `localStorage`，方便静态 HTML 本地评审。
- 如果页面设置 `window.DASHBOARD_COMMENTS_API_BASE`，会切到 HTTP store。

核心原则：

- anchor 是语义身份，不是像素坐标。
- cell comment 绑定 `pageKey / pageVersion / sheetKey / sectionKey / rowKey / columnKey / anchorType`。
- 被折叠或横向滚出可视区的 cell 不显示 pin，但 thread 数据保留。
- 评论系统不修改表格数据、不参与指标计算。

## API contract

生产接 maxx.center 时按这个接口实现：

```http
GET /api/dashboard-comments/threads?pageKey=moclaw_operating_dashboard&pageVersion=v1
POST /api/dashboard-comments/threads
POST /api/dashboard-comments/threads/:threadId/messages
PATCH /api/dashboard-comments/threads/:threadId
```

认证：

- 浏览器请求使用 `credentials: "include"`。
- 后端使用 maxx.center 现有 session。
- 后端写入 author/timestamp，不信任前端传入。

完整字段见：

- `docs/dashboard_comments/API_CONTRACT.md`

## 生成命令

```bash
cd /Users/yee/Documents/agent/docs
python3 build_operating_dashboard_web.py
python3 build_operating_dashboard_home.py
```

## 测试命令

```bash
cd /Users/yee/Documents/agent/docs
node --test dashboard_comments/*.test.mjs
python3 -m pytest test_dashboard_comment_anchors.py -q
node dashboard_comments/playwright_comment_smoke.mjs
```

## 上传目标

远端：

```bash
ssh admin-openclaw
cd /srv/maxcenter-production/maxcenter-source
```

注意：本机 SSH 配置里存在的是 `admin-openclaw`，不是 `admin-opencalw`。

本次上传内容应该放在远端：

- `docs/operating-dashboard/`
- `reference.md`

上传内容包括：

- dashboard 生成器
- home 生成器
- 静态 HTML 输出
- `generated_posthog_metrics/` 当前快照
- `dashboard_comments` 评论模块
- `reference.md`

## 设计原则

- 看板职责是清晰呈现，不替代判断。
- 指标优先从业务问题推导，再看数据能否填。
- 主数据、派生效率、下探项必须在内容和视觉上区分。
- 同一指标只在一个 tab 主管，避免长期漂移。
- 没有真实数据就显示 `—` 或明确待数据，不假装存在。
- 页面要像财报表格一样密集、克制、可扫读。
- 所有定义必须可 hover 查看，不能让读者猜口径。
