-- report_template: dedicated table for report templates (Daily/Weekly/Monthly).
-- Replaces the previous convention of storing templates in the `skills` table
-- with category '日报模板'/'周报模板'/'月报模板', which leaked templates into the
-- agent's available-skills prompt and relied on magic-string matching.
--
-- Resolution waterfall (see template-loader.ts):
--   1. user template bound to the topic   (user_id = ?, topic_id = ?)
--   2. user default template              (user_id = ?, is_default = 1)
--   3. any enabled user template          (user_id = ?)
--   4. system built-in template           (user_id IS NULL)
--   5. code-level fallback                (FALLBACK_TEMPLATES in template-loader.ts)

CREATE TABLE IF NOT EXISTS report_template (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NULL COMMENT 'NULL = system built-in template',
  topic_id    BIGINT UNSIGNED NULL COMMENT 'optional topic binding; NULL = generic for the user',
  period      ENUM('Daily','Weekly','Monthly') NOT NULL,
  name        VARCHAR(128) NOT NULL,
  description VARCHAR(512) NULL,
  content     MEDIUMTEXT NOT NULL COMMENT 'Markdown template body',
  variables   JSON NULL COMMENT 'placeholder metadata for the template editor UI',
  is_default  TINYINT(1) NOT NULL DEFAULT 0,
  is_enable   TINYINT(1) NOT NULL DEFAULT 1,
  -- Partial-unique trick: non-NULL only when is_default = 1, so the unique key
  -- enforces "one default per (user, period)" without constraining non-defaults.
  default_marker VARCHAR(16) AS (IF(is_default = 1, period, NULL)) STORED,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_default_period (user_id, default_marker),
  KEY idx_user_period (user_id, period, is_enable),
  KEY idx_topic (topic_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Seed: system built-in templates (user_id IS NULL).
-- Mirrors FALLBACK_TEMPLATES in template-loader.ts so ops can tune the global
-- defaults in the DB without a code release.
-- ---------------------------------------------------------------------------

INSERT INTO report_template (user_id, topic_id, period, name, description, content)
SELECT NULL, NULL, 'Daily', '系统日报模板', '系统内置日报模板', '# 日报模板

## 概述
{summary}

## 数据概览
- 数据时间范围：{dateScope}
- 数据总量：{totalCount} 条
- 涉及平台：{platforms}

## 舆情摘要
{summaryContent}

## 重点关注
{keyPoints}

## 情感分析
{emotionAnalysis}

## 风险提示
{riskAlerts}

## 建议
{recommendations}
'
WHERE NOT EXISTS (
  SELECT 1 FROM report_template WHERE user_id IS NULL AND period = 'Daily'
);

INSERT INTO report_template (user_id, topic_id, period, name, description, content)
SELECT NULL, NULL, 'Weekly', '系统周报模板', '系统内置周报模板', '# 周报模板

## 概述
{summary}

## 数据概览
- 数据时间范围：{dateScope}
- 数据总量：{totalCount} 条
- 日均数据量：{dailyAvg} 条
- 涉及平台：{platforms}

## 本周舆情趋势
{trendAnalysis}

## 舆情摘要
{summaryContent}

## 重点关注
{keyPoints}

## 情感分析
{emotionAnalysis}

## 风险提示
{riskAlerts}

## 建议
{recommendations}
'
WHERE NOT EXISTS (
  SELECT 1 FROM report_template WHERE user_id IS NULL AND period = 'Weekly'
);

INSERT INTO report_template (user_id, topic_id, period, name, description, content)
SELECT NULL, NULL, 'Monthly', '系统月报模板', '系统内置月报模板', '# 月报模板

## 概述
{summary}

## 数据概览
- 数据时间范围：{dateScope}
- 数据总量：{totalCount} 条
- 日均数据量：{dailyAvg} 条
- 涉及平台：{platforms}

## 本月舆情趋势
{trendAnalysis}

## 舆情摘要
{summaryContent}

## 重点关注
{keyPoints}

## 情感分析
{emotionAnalysis}

## 风险提示
{riskAlerts}

## 建议
{recommendations}
'
WHERE NOT EXISTS (
  SELECT 1 FROM report_template WHERE user_id IS NULL AND period = 'Monthly'
);

-- ---------------------------------------------------------------------------
-- Migration: move existing template rows out of `skills`.
-- Idempotent-ish: skips skills rows already migrated (matched by user+period+name).
-- After copying, the source skills rows are disabled (not deleted) so they stop
-- being injected into the agent prompt but remain recoverable.
-- ---------------------------------------------------------------------------

INSERT INTO report_template (user_id, topic_id, period, name, description, content, is_enable)
SELECT s.user_id,
       NULL,
       CASE s.category
         WHEN '日报模板' THEN 'Daily'
         WHEN '周报模板' THEN 'Weekly'
         WHEN '月报模板' THEN 'Monthly'
       END AS period,
       s.name,
       s.description,
       s.content,
       s.is_enable
FROM skills s
WHERE s.category IN ('日报模板', '周报模板', '月报模板')
  AND s.content IS NOT NULL
  AND s.content <> ''
  AND NOT EXISTS (
    SELECT 1 FROM report_template t
    WHERE (t.user_id <=> s.user_id)
      AND t.name = s.name
      AND t.period = CASE s.category
                       WHEN '日报模板' THEN 'Daily'
                       WHEN '周报模板' THEN 'Weekly'
                       WHEN '月报模板' THEN 'Monthly'
                     END
  );

UPDATE skills
SET is_enable = 0
WHERE category IN ('日报模板', '周报模板', '月报模板');
