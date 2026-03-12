# ⚠️ 필수 규칙: 대시보드 싱크

**지식그래프가 업데이트될 때마다 반드시 옵시디언 대시보드를 업데이트하라.**

그래프 업데이트가 발생하는 모든 경우:

- `daily_enrich.py` 실행 (크론 자동 — 8단계에서 자동 싱크)
- `mnemo.cli build` 수동 실행
- 보강 스크립트 실행 후 재빌드
- 서브에이전트가 그래프를 재빌드한 경우

## 대시보드 싱크 방법

```powershell
cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"
python -c "
import re, json
from pathlib import Path
from datetime import datetime

stats = json.load(open('.mnemo/stats.json', 'r', encoding='utf-8'))
et = stats.get('entity_types', {})
edge_t = stats.get('edge_types', {})
hubs = stats.get('top_hubs', [])[:4]
pr = [n for n, _ in stats.get('top_pagerank', []) if not n.startswith('20')][:3]
today = datetime.now().strftime('%Y-%m-%d')

hub_str = ' · '.join(f'[[{n}]] ({d})' for n, d in hubs)
pr_str = ' · '.join(f'[[{n}]]' for n in pr)
et_str = ' · '.join(f'\`{k}\` {v:,}' for k, v in et.items())
edge_str = ' · '.join(f'\`{k}\` {v:,}' for k, v in edge_t.items())

block = f'''> **Last updated:** {today}

| Metric | Value |
|--------|-------|
| **Nodes** | {stats['nodes']:,} |
| **Edges** | {stats['edges']:,} |
| **Connected Components** | {stats.get('weakly_connected_components', '?')} |
| **Dangling Nodes** | {stats.get('dangling_nodes', '?')} |
| **Density** | {stats.get('density', 0):.4f} |

**Entity Types:**
{et_str}

**Edge Types:**
{edge_str}

**Top Hubs:** {hub_str}

**Top PageRank:** {pr_str}'''

MARKER_RE = re.compile(r'(<!-- AUTO:mnemo-stats:START -->)\n.*?\n(<!-- AUTO:mnemo-stats:END -->)', re.DOTALL)
VAULT = r'C:\Users\jini9\OneDrive\Documents\JINI_SYNC'
files = [
    Path(VAULT) / '01.PROJECT' / '_MASTER_DASHBOARD.md',
    Path(VAULT) / 'TEMPLATES' / 'Dashboard.md',
]
for f in files:
    text = f.read_text(encoding='utf-8')
    new_text, n = MARKER_RE.subn(rf'\1\n{block}\n\2', text)
    if n > 0 and new_text != text:
        f.write_text(new_text, encoding='utf-8')
        print(f'{f.name}: updated')
"
```

## 대시보드 파일 위치

- `01.PROJECT/_MASTER_DASHBOARD.md` — 마스터 대시보드
- `TEMPLATES/Dashboard.md` — 메인 대시보드
- 마커: `<!-- AUTO:mnemo-stats:START -->` ~ `<!-- AUTO:mnemo-stats:END -->`
- 새 대시보드에 마커만 추가하면 자동 싱크 대상에 포함

## 주의사항

- 볼트 변경 후 `mnemo build`로 그래프 갱신 필요 (증분, ~6초)
- 보강 스크립트는 기존 값을 덮어쓰지 않음 (없는 필드만 추가)
- `related:` 추론은 태그 겹침 기반이라 태그가 많을수록 정확
- 백링크는 `## Related Notes` 섹션에 추가 (기존 섹션 있으면 스킵)
- OneDrive 동기화로 아이패드 Obsidian에 자동 반영
- **그래프 업데이트 후 대시보드 싱크를 잊지 말 것!**
