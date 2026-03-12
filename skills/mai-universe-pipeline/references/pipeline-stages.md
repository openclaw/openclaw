# MAI Universe Pipeline — Stage Details

## Stage 1: COLLECT — Knowledge Gathering

### Automation (Built ✅)

- **Mnemo daily_enrich** (daily 05:00 KST): Vault enrichment + graph rebuild
- **Tech Intelligence** (daily 04:00 KST): Tech trend research
- **Biz Intelligence** (daily 04:30 KST): Market/competitor monitoring
- **External Collection** (daily_enrich step 7): YouTube, Brave, GitHub trending

### Collection Sources

| Source                | Method               | Storage                           |
| --------------------- | -------------------- | --------------------------------- |
| Web research          | Brave Search API     | Obsidian `03.RESOURCES/외부지식/` |
| YouTube               | yt-dlp + transcript  | Obsidian `03.RESOURCES/외부지식/` |
| GitHub Trending       | gh API               | Obsidian `03.RESOURCES/외부지식/` |
| 지니 brainstorming    | Discord → memory     | `memory/*.md`                     |
| NotebookLM            | Official API pending | (future) Obsidian integration     |
| Mnemo knowledge graph | Auto-link/inference  | `.mnemo/graph.pkl`                |

### Manual Commands

```powershell
# Manual knowledge collection
cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"
python scripts/collect_knowledge.py              # All projects
python scripts/collect_knowledge.py MAIOSS MAITOK # Specific projects

# Manual graph rebuild
python -m mnemo.cli build "C:\Users\jini9\OneDrive\Documents\JINI_SYNC" --include-memory "C:\MAIBOT\memory" --cache-dir ".mnemo"
```

---

## Stage 2: DISCOVER — Opportunity Detection

### Automation (Partial ✅)

- **Biz intelligence briefing**: Market opportunity detection
- **Cross-project reasoning**: Mnemo GraphRAG for project synergy discovery

### Contribution-Revenue Balance Matrix

```
              Revenue High
                 ▲
    ┌────────────┼────────────┐
    │ 🟡 Pure Rev │ 🟢 Golden   │
    │ (Short OK,  │ (Contrib+Rev│
    │  Long weak) │  virtuous)  │
    ├────────────┼────────────┤
    │ 🔴 Avoid    │ 🔵 Seed     │
    │ (No value)  │ (Contrib 1st│
    │             │  Rev later) │
    └────────────┼────────────┘
                 ▼
              Revenue Low
    Contrib Low ◀──────────▶ Contrib High
```

**🟢 Golden Zone examples:**

- MAIOSS: Open-source security tools → enterprise trust → B2B contracts
- Mnemo: Free Obsidian plugin → community → premium SaaS
- MAIBOTALKS: OpenClaw ecosystem contribution → paid app store app

### Opportunity Evaluation Checklist

- [ ] Synergy with existing MAI Universe ecosystem?
- [ ] Can share infrastructure? (BOT Suite pattern)
- [ ] Stronger with more contributions?
- [ ] More sustainable with monetization?
- [ ] Can survive independently?

### Workflow: On Opportunity Discovery

1. Record idea in `memory/`
2. Evaluate on balance matrix
3. Cross-project synergy analysis (Mnemo cross-search)
4. Brief 지니 → approval
5. Move to Stage 3

---

## Stage 3: CREATE — Project Creation

### Automation (Built ✅)

Use **mai-project-init** skill: `/새 프로젝트 {name} "{description}"`

Auto-creates:

1. `C:\TEST\MAI{name}` local workspace
2. `docs/` folder + document templates
3. Obsidian `01.PROJECT/{NN}.MAI{name}` + docs symlink
4. GitHub private repo
5. MAIBOT memory file
6. MEMORY.md index update
7. Auto-included in Mnemo graph (next daily_enrich)

### Required Artifacts

| Doc                   | Prefix | Content                      |
| --------------------- | ------ | ---------------------------- |
| PRD                   | A001   | Product planning             |
| Competitive Analysis  | A002   | Market/competitors           |
| Monetization Strategy | A003   | Contribution-revenue balance |
| Technical Design      | D001   | Architecture                 |
| Dev Plan              | I001   | Sprint/milestones            |

---

## Stage 4: BUILD — Development

### Automation (Built ✅)

- **MAIBOT direct implementation** — code read/write/edit + git
- **Sub-agent teams** — parallel processing for large tasks

### Quality Standards

- Test coverage ≥ 70%
- Code files ≤ 700 LOC
- Doc sync (docs/ + Obsidian)

---

## Stage 5: DEPLOY — Launch

### Deployment Targets

| Type           | Platform               | Example              |
| -------------- | ---------------------- | -------------------- |
| Web service    | Railway / Vercel       | MAIOSS, MAIBEAUTY    |
| Mobile app     | App Store / Play Store | MAIBOTALKS, MAITUTOR |
| OpenClaw skill | clawhub.com            | Mnemo, bot skills    |
| OSS tool       | GitHub + npm/pip       | MAIOSS scanner       |
| SaaS           | Own domain             | Mnemo Cloud (future) |

### Deployment Checklist

- [ ] README.md complete
- [ ] License specified
- [ ] Privacy policy (if collecting user data)
- [ ] Terms of service
- [ ] CI/CD pipeline
- [ ] Monitoring/alerting setup

---

## Stage 6: REALIZE — Contribution/Revenue

### Contribution Channels

| Channel     | Method                                  | Metric                     |
| ----------- | --------------------------------------- | -------------------------- |
| Open source | GitHub public repos, PRs, issue answers | Stars, Forks, Contributors |
| Community   | Discord, blog, YouTube                  | Members, views             |
| Education   | Online courses, tutorials               | Students                   |
| Tools       | Free plugins/skills                     | Downloads                  |

### Revenue Channels

| Channel          | Method                        | Target        |
| ---------------- | ----------------------------- | ------------- |
| App subscription | BOT Suite (₩3,900/mo~)        | MRR           |
| Enterprise       | MAIOSS B2B license            | ARR           |
| SaaS             | Mnemo Cloud                   | MRR           |
| Consulting       | AI automation (n8n, OpenClaw) | Per-project   |
| Content          | TikTok/YouTube (AI-generated) | Ads/commerce  |
| Staffing         | MAISTAR7 commission           | Per-placement |
