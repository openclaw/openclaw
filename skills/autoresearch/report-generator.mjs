// report-generator.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

export function buildMarkdownReport({ date, experiments, token, totalCost, flags = [], opusComparison = [] }) {
  const wins = experiments.filter(e => e.outcome === 'commit').length;
  const flagsMd = flags.length
    ? `## 🚩 Flags\n${flags.map(f => `- **${f.type}** on \`${f.skill}\`: ${f.detail || ''}`).join('\n')}\n\n`
    : '';

  const bySkill = {};
  for (const e of experiments) (bySkill[e.skill] ||= []).push(e);
  const skillSections = Object.entries(bySkill).map(([skill, exps]) => {
    const lines = exps.map(e => {
      const arrow = e.outcome === 'commit' ? '✅' : '↩';
      return `  ${arrow} exp#${e.exp} (${e.model}): ${e.old_f1.toFixed(3)} → ${e.new_f1.toFixed(3)} (${e.delta >= 0 ? '+' : ''}${e.delta.toFixed(3)})`;
    }).join('\n');
    return `### ${skill}\n${lines}`;
  }).join('\n\n');

  const opusMd = opusComparison.length
    ? `## Opus Sanity-Check\n${opusComparison.map(o => `- \`${o.skill}\`: Haiku ${o.haiku_old.toFixed(3)}→${o.haiku_new.toFixed(3)} | Opus ${o.opus_old.toFixed(3)}→${o.opus_new.toFixed(3)} ${o.agreement ? '✓' : '🚩'}`).join('\n')}\n\n`
    : '';

  return `# Autoresearch Report — ${date}

## 🎯 Action

- **[✅ APPROVE](http://localhost:9876/approve?token=${token}&date=${date})** — squash-merge branch to main
- **[❌ REJECT](http://localhost:9876/reject?token=${token}&date=${date})** — discard all experiments

## Summary

- Experiments: ${experiments.length}
- Wins: ${wins}
- Cost (API): $${totalCost.toFixed(2)}

${flagsMd}${opusMd}## Experiments by skill

${skillSections}
`;
}

export function renderMarkdownToPdf(mdPath, pdfPath) {
  const htmlPath = mdPath.replace(/\.md$/, '.html');
  const md = readFileSync(mdPath, 'utf8');
  // Minimal inline MD-to-HTML (we don't need a full parser for v1 — basic structure is enough).
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Segoe UI,Arial,sans-serif;max-width:800px;margin:2em auto;padding:0 1em;}h1{border-bottom:2px solid #02020E}h2{color:#0A9EFC}a{display:inline-block;padding:8px 16px;background:#0A9EFC;color:white;text-decoration:none;border-radius:4px;margin-right:8px}code{background:#f4f4f4;padding:2px 6px;border-radius:3px}</style></head><body>${mdToHtml(md)}</body></html>`;
  writeFileSync(htmlPath, html);
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  execSync(`"${edge}" --headless --disable-gpu --print-to-pdf="${pdfPath}" "${htmlPath}"`, { stdio: 'ignore' });
}

function mdToHtml(md) {
  return md
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^/, '<p>') + '</p>';
}
