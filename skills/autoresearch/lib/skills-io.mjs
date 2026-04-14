import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export function listSkills(skillsDir) {
  return readdirSync(skillsDir).filter(name => {
    const p = join(skillsDir, name, 'SKILL.md');
    return existsSync(p) && statSync(p).isFile();
  });
}

function parseFrontmatter(content) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) throw new Error('No frontmatter');
  return { raw: m[1], body: content.slice(m[0].length), fullMatch: m[0] };
}

export function readSkillDescription(skillsDir, name) {
  const content = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
  const { raw } = parseFrontmatter(content);
  const line = raw.split('\n').find(l => l.startsWith('description:'));
  if (!line) throw new Error(`No description in ${name}`);
  const value = line.replace(/^description:\s*/, '').trim();
  // Handle both quoted ("..." / '...') and unquoted forms.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return JSON.parse(value.replace(/^'|'$/g, '"'));
  }
  return value;
}

export function writeSkillDescription(skillsDir, name, newDesc) {
  const path = join(skillsDir, name, 'SKILL.md');
  const content = readFileSync(path, 'utf8');
  const { raw, body } = parseFrontmatter(content);
  const lines = raw.split('\n');
  const idx = lines.findIndex(l => l.startsWith('description:'));
  if (idx === -1) throw new Error(`No description line in ${name}`);
  // JSON.stringify produces safe YAML-compatible double-quoted string.
  lines[idx] = `description: ${JSON.stringify(newDesc)}`;
  writeFileSync(path, `---\n${lines.join('\n')}\n---\n${body}`);
}
