export interface RecommendedSkill {
  slug: string;
  name: string;
  category: string;
  description: string;
  reason: string;
  sourceUrl: string;
}

// Curated from awesome-openclaw-skills README:
// /Users/tg/Projects/OpenClaw/awesome-openclaw-skills/README.md
// These are high-impact skills for engineering workflow, delivery, and ops.
export const DASHBOARD_RECOMMENDED_SKILLS: RecommendedSkill[] = [
  {
    slug: "github",
    name: "github",
    category: "Git & PR",
    description: "Interact with GitHub using the gh CLI.",
    reason: "Direct PR triage and repo management from agent workflows.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/steipete/github/SKILL.md",
  },
  {
    slug: "github-pr",
    name: "github-pr",
    category: "Git & PR",
    description: "Fetch, preview, merge, and test GitHub PRs locally.",
    reason: "Shortens review-to-merge cycle with deterministic local validation.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/dbhurley/github-pr/SKILL.md",
  },
  {
    slug: "auto-pr-merger",
    name: "auto-pr-merger",
    category: "Git & PR",
    description: "Automates checking out and merging GitHub pull requests.",
    reason: "Removes repetitive merge operations after checks are green.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/autogame-17/auto-pr-merger/SKILL.md",
  },
  {
    slug: "conventional-commits",
    name: "conventional-commits",
    category: "Git Hygiene",
    description: "Formats commit messages using Conventional Commits.",
    reason: "Improves changelog quality and release automation consistency.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/bastos/conventional-commits/SKILL.md",
  },
  {
    slug: "test-runner",
    name: "test-runner",
    category: "Quality",
    description: "Write and run tests across languages and frameworks.",
    reason: "Raises validation coverage before deployment.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/cmanfre7/test-runner/SKILL.md",
  },
  {
    slug: "debug-pro",
    name: "debug-pro",
    category: "Quality",
    description: "Systematic debugging methodology and language-specific workflows.",
    reason: "Cuts MTTR by standardizing incident diagnosis.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/cmanfre7/debug-pro/SKILL.md",
  },
  {
    slug: "tdd-guide",
    name: "tdd-guide",
    category: "Quality",
    description: "Test-driven development workflow with test generation and coverage.",
    reason: "Encourages safer refactors and regression-resistant changes.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/alirezarezvani/tdd-guide/SKILL.md",
  },
  {
    slug: "mcp-builder",
    name: "mcp-builder",
    category: "Platform",
    description: "Guide for creating high-quality MCP servers.",
    reason: "Expands tool surface area cleanly for dashboard automations.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/seanphan/mcp-builder/SKILL.md",
  },
  {
    slug: "docker-essentials",
    name: "docker-essentials",
    category: "DevOps",
    description: "Essential Docker commands and container workflows.",
    reason: "Improves local reproducibility and deployment parity.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/arnarsson/docker-essentials/SKILL.md",
  },
  {
    slug: "cloudflare",
    name: "cloudflare",
    category: "DevOps",
    description: "Manage Cloudflare Workers, KV, D1, R2, and secrets via Wrangler.",
    reason: "Enables first-class edge deployment and infra workflows.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/asleep123/wrangler/SKILL.md",
  },
  {
    slug: "vercel-deploy",
    name: "vercel-deploy",
    category: "DevOps",
    description: "Deploy applications and websites to Vercel.",
    reason: "Aligns with existing Vercel integration and closes deploy loop.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/sharanga10/vercel-deploy-claimable/SKILL.md",
  },
  {
    slug: "netlify",
    name: "netlify",
    category: "DevOps",
    description: "Use Netlify CLI to create/link sites and manage CI/CD.",
    reason: "Adds an additional deployment target beyond current integrations.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/ajmwagar/netlify/SKILL.md",
  },
  {
    slug: "ssh-tunnel",
    name: "ssh-tunnel",
    category: "Infra",
    description: "SSH tunneling, port forwarding, and remote access patterns.",
    reason: "Useful for secure access to private infra and staging services.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/gitgoodordietrying/ssh-tunnel/SKILL.md",
  },
  {
    slug: "skill-vetting",
    name: "skill-vetting",
    category: "Security",
    description: "Vet ClawHub skills for security and utility before installation.",
    reason: "Reduces supply-chain risk from untrusted skill installation.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/eddygk/skill-vetting/SKILL.md",
  },
  {
    slug: "release-bump",
    name: "release-bump",
    category: "Release",
    description: "Guidance for deterministic version bumps and release prep.",
    reason: "Improves release repeatability and reduces versioning drift.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/paulpete/release-bump/SKILL.md",
  },
  {
    slug: "codex-orchestration",
    name: "codex-orchestration",
    category: "Agent Ops",
    description: "General-purpose orchestration for Codex workflows.",
    reason: "Useful for parallel task execution and workflow decomposition.",
    sourceUrl:
      "https://github.com/openclaw/skills/tree/main/skills/shanelindsay/codex-orchestration/SKILL.md",
  },
];

