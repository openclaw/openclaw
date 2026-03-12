# MAI Universe — Project Status Matrix

## Current Project Mapping (Pipeline Validation)

| Project    | Stage            | Contribution              | Revenue             | Balance    |
| ---------- | ---------------- | ------------------------- | ------------------- | ---------- |
| MAIBOT     | 4 (Operating)    | OpenClaw ecosystem        | —                   | 🔵 Seed    |
| MAIOSS     | 4 (Dev)          | OSS security tools        | B2B license         | 🟢 Golden  |
| MAIBEAUTY  | 4 (Dev)          | —                         | AI sales automation | 🟡 Revenue |
| MAISTAR7   | 3 (Design)       | KR-VN staffing bridge     | Matching commission | 🟢 Golden  |
| MAICON     | 3 (Design)       | Local service access      | Booking commission  | 🟢 Golden  |
| MAITUTOR   | 3 (Design)       | Language education access | App subscription    | 🟢 Golden  |
| MAIBOTALKS | 5 (Deploy-ready) | OpenClaw client           | ₩3,900/mo           | 🟢 Golden  |
| MAITOK     | 3 (Design)       | TikTok creator tools      | SaaS subscription   | 🟢 Golden  |
| Mnemo      | 4 (Dev)          | Obsidian plugin           | SaaS/education      | 🟢 Golden  |

**7 of 9 projects in 🟢 Golden Zone** — contribution and revenue in virtuous cycle.

## Automation Status & Roadmap

| Stage       | Current                                      | Target                           |
| ----------- | -------------------------------------------- | -------------------------------- |
| 1. COLLECT  | ✅ Auto (5 cron + daily_enrich)              | More source integrations         |
| 2. DISCOVER | ✅ Auto (daily_enrich step 10 + weekly cron) | Precision improvement            |
| 3. CREATE   | ✅ Auto (mai-project-init)                   | Enhanced doc template generation |
| 4. BUILD    | ✅ Auto (3-Layer multi-agent)                | CI/CD pipeline standardization   |
| 5. DEPLOY   | 🔴 Manual                                    | One-click deploy automation      |
| 6. REALIZE  | 🔴 Manual                                    | Revenue/contribution dashboard   |

### Stage 2 Automation (Built 2026-02-24)

**Daily opportunity scan (daily_enrich step 10):**

- Auto-detect opportunities from Mnemo knowledge graph + external knowledge
- 4-axis scoring (contribution/revenue/synergy/feasibility)
- Auto-save 🟢 golden zone opportunities as Obsidian reports

**Weekly opportunity review (Mon 07:30 KST cron):**

- Refresh all project scoring
- Cross-project synergy analysis
- Discord DM briefing for golden zone opportunities
- Identify projects needing stage transitions

### Next Priority Automation

1. **Stage 2 precision**: Keyword-based → LLM-based opportunity evaluation
2. **Stage 5 enhancement**: Railway/Vercel/app store deploy automation
3. **Stage 6 enhancement**: Revenue/contribution KPI auto-collection + dashboard
