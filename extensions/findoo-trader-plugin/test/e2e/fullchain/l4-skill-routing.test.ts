/**
 * L4 -- Skill Routing Accuracy
 *
 * Validates that user intents map to the correct skill based on
 * skill.md frontmatter (name + description + "When to Use" triggers).
 *
 * This test does NOT call an LLM. It parses the skill metadata from
 * the skills/ directory and verifies that intent keywords match the
 * expected skill name. This is the "contract test" layer for skill routing.
 *
 * For true LLM routing accuracy, see the .live.test.ts variant.
 *
 * Skills under test (8):
 *   fin-overview, fin-trader, fin-strategy, fin-quant-fund,
 *   fin-strategy-evolution, fin-trade-review, fin-strategy-research, fin-setting
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/l4-skill-routing.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// -- Skill metadata parser --

type SkillMeta = {
  name: string;
  description: string;
  fullText: string;
};

function parseSkillMeta(skillDir: string): SkillMeta[] {
  const skills: SkillMeta[] = [];
  const baseDir = join(skillDir, "../../../skills");
  const dirs = readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const dir of dirs) {
    const skillPath = join(baseDir, dir.name, "skill.md");
    try {
      const content = readFileSync(skillPath, "utf-8");
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const descMatch = content.match(/^description:\s*"?([^"]+)"?$/m);
      if (nameMatch) {
        skills.push({
          name: nameMatch[1].trim(),
          description: descMatch?.[1]?.trim() ?? "",
          fullText: content.toLowerCase(),
        });
      }
    } catch {
      // skip missing files
    }
  }

  return skills;
}

/**
 * Score how well a user intent matches a skill.
 * Uses keyword overlap between intent and skill description + body text.
 * Higher-weight keywords (unique to a skill) get boosted.
 */
function scoreMatch(intent: string, skill: SkillMeta): number {
  const intentLower = intent.toLowerCase();
  const words = intentLower.split(/\s+/).filter((w) => w.length > 2);
  let score = 0;

  const descLower = skill.description.toLowerCase();

  // Direct keyword matches in description (higher weight)
  for (const word of words) {
    if (descLower.includes(word)) score += 3;
    if (skill.fullText.includes(word)) score += 1;
  }

  // Exact phrase match bonus
  if (skill.fullText.includes(intentLower)) score += 10;

  // Penalize if skill name contains "strategy" but intent is about evolution/lifecycle
  // and skill is the generic strategy skill (not the evolution one)
  if (skill.name === "fin-strategy" && /evolv|mutat|lifecycle|cull|demot/.test(intentLower)) {
    score -= 5;
  }
  if (skill.name === "fin-strategy-evolution" && /creat|backtest|list|promot/.test(intentLower)) {
    score -= 3;
  }

  return score;
}

function findBestSkill(intent: string, skills: SkillMeta[]): string {
  let bestScore = -1;
  let bestSkill = "";

  for (const skill of skills) {
    const score = scoreMatch(intent, skill);
    if (score > bestScore) {
      bestScore = score;
      bestSkill = skill.name;
    }
  }

  return bestSkill;
}

// ============================================================

describe("L4 -- Skill Routing Accuracy", () => {
  const skills = parseSkillMeta(__dirname);

  it("loads all 8 skills from the skills directory", () => {
    expect(skills.length).toBe(8);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual([
      "fin-overview",
      "fin-quant-fund",
      "fin-setting",
      "fin-strategy",
      "fin-strategy-evolution",
      "fin-strategy-research",
      "fin-trade-review",
      "fin-trader",
    ]);
  });

  // -- Overview skill --

  it("routes 'account overview' to fin-overview", () => {
    expect(findBestSkill("my account overview status", skills)).toBe("fin-overview");
  });

  it("routes 'daily brief' to fin-overview", () => {
    expect(findBestSkill("daily brief summary", skills)).toBe("fin-overview");
  });

  // -- Trader skill --

  it("routes 'buy ETH' to fin-trader", () => {
    expect(findBestSkill("buy ETH place order", skills)).toBe("fin-trader");
  });

  it("routes 'check positions' to fin-trader", () => {
    expect(findBestSkill("check my positions order book", skills)).toBe("fin-trader");
  });

  // -- Strategy skill --

  it("routes 'create a strategy' to fin-strategy", () => {
    expect(findBestSkill("create a new trading strategy", skills)).toBe("fin-strategy");
  });

  it("routes 'backtest results' to fin-strategy", () => {
    expect(findBestSkill("backtest results ranking promote", skills)).toBe("fin-strategy");
  });

  // -- Quant Fund skill --

  it("routes 'rebalance fund' to fin-quant-fund", () => {
    expect(findBestSkill("rebalance fund capital allocation", skills)).toBe("fin-quant-fund");
  });

  it("routes 'leaderboard' to fin-quant-fund", () => {
    expect(findBestSkill("strategy leaderboard fund status", skills)).toBe("fin-quant-fund");
  });

  // -- Strategy Evolution skill --

  it("routes 'evolve strategies' to fin-strategy-evolution", () => {
    expect(findBestSkill("evolve my strategies mutation lifecycle", skills)).toBe(
      "fin-strategy-evolution",
    );
  });

  // -- Trade Review skill --

  it("routes 'trade review' to fin-trade-review", () => {
    expect(findBestSkill("review today trades replay mistakes error book", skills)).toBe(
      "fin-trade-review",
    );
  });

  // -- Strategy Research skill --

  it("routes 'research strategy with walk-forward' to fin-strategy-research", () => {
    expect(findBestSkill("research strategy analyze market regime walk-forward", skills)).toBe(
      "fin-strategy-research",
    );
  });

  // -- Setting skill --

  it("routes 'add exchange' to fin-setting", () => {
    expect(findBestSkill("add exchange connect binance configure", skills)).toBe("fin-setting");
  });

  // -- Negative / disambiguation tests --

  it("does not confuse 'create and backtest' with 'strategy evolution'", () => {
    const result = findBestSkill("create and backtest a strategy", skills);
    expect(result).not.toBe("fin-strategy-evolution");
  });

  it("does not confuse 'fund risk' with 'trader'", () => {
    const result = findBestSkill("fund risk monitoring capital allocation", skills);
    expect(result).toBe("fin-quant-fund");
  });
});
