# 本地足球数据（Football local data）

从多个**注册数据源**拉取 **CSV** 到本地，包括 [Football-Data.co.uk](https://www.football-data.co.uk/)、任意 HTTP CSV，以及 **[FBref](https://fbref.com/)（Sports Reference）** 的进阶统计表（经 Python **soccerdata** 导出）。用于统计、回测与建模；**不构成投注建议**。

## 入口脚本

- **`skills/football-local-data/scripts/local-data-fetch.mjs`**（主入口，支持 **`--sources`** 多数据源）
- **`skills/football-local-data/scripts/football-data-fetch.mjs`**（兼容旧名，内部转发到同一引擎）

## 数据源（`--sources`）

| 源 id                     | 说明                                                                                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`football-data-co-uk`** | Football-Data.co.uk 赛季 CSV：`--preset`、`--leagues`、`--season` / `--season-range` / `--seasons`，或仅 **`--urls`**（完整 URL）                                                                                                                              |
| **`http-csv`**            | 仅 **`--urls`**（可搭配其它源：与 `football-data-co-uk` 组合时，可用 `--preset` 给前者）                                                                                                                                                                       |
| **`fbref`**               | **FBref / Sports Reference**：需 **Python 3** 与 `pip install -r skills/football-local-data/requirements-fbref.txt`（**soccerdata** + **pandas**）。通过 `scripts/fbref-fetch.py` 导出赛程、球队/球员**赛季**聚合表，可选**场次级**表（`--fbref-depth extended | full`，数据量极大）。**`--preset all`** 使用 soccerdata 提供的 **`FBref.available_leagues()`** 全联赛列表；**`--leagues ALL`** 同上；也可用 **`--season-range 1993-2025`** 拉长时间轴。并非官方「一键全站镜像」，覆盖范围以 **soccerdata 对 FBref 的解析能力**为准；请务必遵守 Sports Reference / FBref 使用条款并控制频率（**`--delay-ms`\*\*）。 |
| **`all`**                 | 当前所有**无需额外环境**的自动源（仅 **`football-data-co-uk`**；**`http-csv`**、**`fbref`** 需显式写出）                                                                                                                                                       |

默认 **`--sources football-data-co-uk`**。多源时输出为 **`OUT/<源id>/`**；单源时文件直接在 **`OUT/`** 下。

## FBref 依赖安装

```bash
pip install -r skills/football-local-data/requirements-fbref.txt
```

## 典型用法

```bash
# 推断当前赛季，英格兰预设（Football-Data）
node skills/football-local-data/scripts/local-data-fetch.mjs \
  --out ./var/football-data \
  --preset england

# 多赛季（赛季起始年闭区间，Football-Data）
node skills/football-local-data/scripts/local-data-fetch.mjs \
  --out ./var/football-data-full \
  --preset all \
  --season-range 1993-2025 \
  --delay-ms 400

# FBref：全联赛（soccerdata 枚举）+ 长赛季区间；默认深度为 core（赛季聚合 + 赛程）
node skills/football-local-data/scripts/local-data-fetch.mjs \
  --out ./var/fbref-data \
  --sources fbref \
  --preset all \
  --season-range 1993-2025 \
  --fbref-depth core \
  --delay-ms 500

# 同时拉 Football-Data 预设 + 额外若干 CSV URL
node skills/football-local-data/scripts/local-data-fetch.mjs \
  --out ./var/football-data \
  --sources football-data-co-uk,http-csv \
  --preset england \
  --urls "https://example.com/extra.csv"
```

## 与 football-match-analyst 配合

**Football-Data.co.uk** 下载的 CSV 可由 **`football-match-analyst`** 的 `match-context.mjs` 使用 **`--provider football-data --csv <路径>`** 生成 **`llmPack`**（列格式需与 Football-Data 一致）。

**FBref** 导出为宽表统计，**列结构不同**，不能作为上述 **`football-data`** 提供者的直接替换；适合用 **Pandas** 等做独立分析。

## 扩展数据源

在 `scripts/sources/` 下新增模块并在 `registry.mjs` 注册；英文说明见同目录 **`SKILL.md`**。

## OpenClaw

Football-Data / HTTP 源无 API Key；FBref 需本机 Python 环境。参见 [Skills 配置](https://docs.openclaw.ai/tools/skills-config)。

## 合规

数据用于研究与建模；遵守各站点条款、引用要求与合理抓取频率。
