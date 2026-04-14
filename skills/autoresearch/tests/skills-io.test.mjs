import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readSkillDescription, writeSkillDescription, listSkills } from '../lib/skills-io.mjs';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('skills-io', () => {
  let dir;
  beforeEach(() => {
    dir = join(tmpdir(), `sio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(dir, 'alpha'), { recursive: true });
    mkdirSync(join(dir, 'beta'), { recursive: true });
    writeFileSync(join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: First skill\n---\nBody');
    writeFileSync(join(dir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Second skill\n---\nBody');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('listSkills returns all skill names', () => {
    expect(listSkills(dir).sort()).toEqual(['alpha', 'beta']);
  });

  it('readSkillDescription returns description', () => {
    expect(readSkillDescription(dir, 'alpha')).toBe('First skill');
  });

  it('writeSkillDescription preserves body and other fields', () => {
    writeSkillDescription(dir, 'alpha', 'Updated description');
    const content = readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8');
    expect(content).toContain('name: alpha');
    expect(content).toContain('Body');
    expect(readSkillDescription(dir, 'alpha')).toBe('Updated description');
  });

  it('writeSkillDescription round-trips long descriptions', () => {
    const long = 'A description '.repeat(20).trim();
    writeSkillDescription(dir, 'alpha', long);
    expect(readSkillDescription(dir, 'alpha')).toBe(long);
  });
});
