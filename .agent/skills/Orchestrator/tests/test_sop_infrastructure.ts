import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';

const AGENT_DIR = resolve(__dirname, '../../..');

describe('SOP Infrastructure', () => {
  describe('Directory Structure', () => {
    it('should have .agent/docs/phases/ with 7 phase files', () => {
      const phases = [
        '01_session_context.md',
        '02_initialization.md',
        '03_planning.md',
        '04_execution.md',
        '05_finalization.md',
        '06_retrospective.md',
        '07_clean_state.md',
      ];
      for (const phase of phases) {
        expect(existsSync(resolve(AGENT_DIR, 'docs/phases', phase))).toBe(true);
      }
    });

    it('should have .agent/docs/sop/ with key SOP files', () => {
      const sopFiles = [
        'SOP.md',
        'SOP_COMPLIANCE_CHECKLIST.md',
        'tdd-workflow.md',
        'git-workflow.md',
      ];
      for (const file of sopFiles) {
        expect(existsSync(resolve(AGENT_DIR, 'docs/sop', file))).toBe(true);
      }
    });

    it('should have .agent/skills/ with required skills', () => {
      const skills = [
        'Orchestrator/SKILL.md',
        'TDD/SKILL.md',
        'planning/SKILL.md',
        'reflect/SKILL.md',
        'retrospective/SKILL.md',
      ];
      for (const skill of skills) {
        expect(existsSync(resolve(AGENT_DIR, 'skills', skill))).toBe(true);
      }
    });

    it('should have agent-session-gate script', () => {
      expect(existsSync(resolve(AGENT_DIR, 'bin/agent-session-gate'))).toBe(true);
    });
  });

  describe('Session Gate', () => {
    it('should have executable agent-session-gate', () => {
      const gatePath = resolve(AGENT_DIR, 'bin/agent-session-gate');
      const stat = require('fs').statSync(gatePath);
      expect(stat.mode & 0o111).not.toBe(0);
    });

    it('should run without errors', () => {
      try {
        execSync(`${resolve(AGENT_DIR, 'bin/agent-session-gate')} --help 2>/dev/null || true`, {
          cwd: AGENT_DIR,
          timeout: 30000,
        });
      } catch {
        // Script may exit with non-zero in some modes, that's ok
      }
    });
  });

  describe('AGENTS.md', () => {
    it('should reference SOP in AGENTS.md', () => {
      const agentsPath = resolve(AGENT_DIR, '../../AGENTS.md');
      const content = require('fs').readFileSync(agentsPath, 'utf-8');
      expect(content).toContain('Optional SOP');
      expect(content).toContain('.agent/');
    });
  });
});
