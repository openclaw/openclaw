import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY_PATH = "reports/openclaw-card-framework-cards.json";
const BUILDER_SKILL_PATH = "skills/openclaw-card-framework-builder/SKILL.md";
const ARCHITECTURE_WORLD_MODEL_STUDY_PATH =
  "reports/openclaw-architecture-world-model-open-source-study.md";

const REQUIRED_TYPES = new Set([
  "source",
  "component",
  "capability",
  "module",
  "contract",
  "validation",
  "report",
]);
const REQUIRED_TARGETS = new Set(["docs", "skill", "plugin", "runtime", "taskflow"]);
const REQUIRED_CARD_IDS = new Set([
  "source-architecture-as-code-standards",
  "module-architecture-model-as-code",
  "source-world-model-simulation-standards",
  "module-world-model-simulation-gate",
  "contract-architecture-world-model-drift-gate",
  "source-3d-viewpoint-node-graph-standards",
  "module-3d-viewpoint-node-model",
  "contract-3d-viewpoint-node-graph-gate",
]);
const REQUIRED_ARRAY_FIELDS = ["sourceUrls", "inputs", "outputs", "risk", "validation", "linksTo"];
const REQUIRED_STRING_FIELDS = [
  "id",
  "type",
  "title",
  "summary",
  "openclawTarget",
  "contract",
  "rollbackPath",
  "nextSafeTask",
  "humanReadableCheck",
];

const TARGET_RULES = {
  source: new Set(["docs"]),
  component: new Set(["docs", "skill", "plugin", "runtime", "taskflow"]),
  capability: new Set(["skill"]),
  module: new Set(["plugin", "runtime", "taskflow"]),
  contract: new Set(["runtime"]),
  validation: new Set(["runtime"]),
  report: new Set(["docs"]),
};

const REQUIRED_COMPONENT_ROLES = new Set([
  "gateway",
  "channel",
  "plugin-loader",
  "plugin-sdk",
  "extension",
  "skill",
  "controlled-runner",
  "taskflow",
  "scheduler-hooks",
  "memory",
  "ui-surface",
  "config",
  "validation-gate",
  "report-state",
  "trading-runtime",
  "trading-risk-gate",
]);

const REQUIRED_COMPONENT_LINKS = [
  { fromRole: "gateway", toRoles: ["channel", "plugin-loader"] },
  { fromRole: "plugin-loader", toRoles: ["plugin-sdk", "extension"] },
  { fromRole: "controlled-runner", toRoles: ["taskflow", "validation-gate"] },
  { fromRole: "scheduler-hooks", toRoles: ["controlled-runner", "taskflow"] },
  {
    fromRole: "trading-runtime",
    toRoles: ["trading-risk-gate", "validation-gate", "report-state"],
  },
  { fromRole: "trading-risk-gate", toRoles: ["validation-gate", "report-state"] },
  { fromRole: "ui-surface", toRoles: ["gateway", "report-state"] },
  { fromRole: "memory", toRoles: ["report-state", "validation-gate"] },
];

const BUILDER_SKILL_TERMS = [
  "Source Card",
  "Component Card",
  "Capability Card",
  "Module Card",
  "Contract Card",
  "Validation Card",
  "Report Card",
  "pnpm check:openclaw-card-framework",
  "BLOCKED_CARD_FRAMEWORK",
  "falseAccepted=0",
  "falseBlocked=0",
  "docs",
  "skill",
  "plugin",
  "runtime",
  "taskflow",
  "componentRole",
  "componentPaths",
  "trading-risk-gate",
  "Architecture Card",
  "World Model Card",
  "3D Viewpoint Card",
  "3D Node Graph Card",
  "architecture-as-code",
  "world-model simulation",
  "3D viewpoint",
  "2D fallback",
  "drift detection",
];

const CONTROLLED_RUNNER_PREFLIGHT_TERMS = [
  "collectCardFrameworkReport",
  "runCardFrameworkPreflight",
  "card_framework_preflight",
  "BLOCKED_CARD_FRAMEWORK",
  "simulationIterations: 1000",
  "buildCardFrameworkBlockedCommandResult",
];

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function pathExists(repoRoot, repoRelativePath) {
  if (path.isAbsolute(repoRelativePath) || repoRelativePath.split(/[\\/]/).includes("..")) {
    return false;
  }
  try {
    const stats = await fs.stat(path.join(repoRoot, repoRelativePath));
    return stats.isFile();
  } catch {
    return false;
  }
}

async function repoPathExists(repoRoot, repoRelativePath) {
  if (path.isAbsolute(repoRelativePath) || repoRelativePath.split(/[\\/]/).includes("..")) {
    return false;
  }
  try {
    await fs.stat(path.join(repoRoot, repoRelativePath));
    return true;
  } catch {
    return false;
  }
}

function addCheck(checks, id, label, status, message, cardId = null) {
  checks.push({ id, label, status, message, cardId });
}

async function validateSourceUrls(repoRoot, checks, card) {
  for (const sourceUrl of card.sourceUrls ?? []) {
    if (isHttpUrl(sourceUrl)) {
      continue;
    }
    if (await pathExists(repoRoot, sourceUrl)) {
      continue;
    }
    addCheck(
      checks,
      `card:${card.id}:source:${sourceUrl}`,
      "來源連結",
      "fail",
      `來源不存在或不是允許 URL/repo path: ${sourceUrl}`,
      card.id,
    );
  }
}

function validateCardShape(checks, card, ids) {
  for (const field of REQUIRED_STRING_FIELDS) {
    if (!nonEmptyString(card[field])) {
      addCheck(
        checks,
        `card:${card.id ?? "unknown"}:${field}`,
        "必要欄位",
        "fail",
        `缺少文字欄位: ${field}`,
        card.id ?? null,
      );
    }
  }

  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!nonEmptyStringArray(card[field])) {
      addCheck(
        checks,
        `card:${card.id ?? "unknown"}:${field}`,
        "必要欄位",
        "fail",
        `缺少清單欄位: ${field}`,
        card.id ?? null,
      );
    }
  }

  if (nonEmptyString(card.type) && !REQUIRED_TYPES.has(card.type)) {
    addCheck(
      checks,
      `card:${card.id}:type`,
      "卡片類型",
      "fail",
      `不支援的 type: ${card.type}`,
      card.id,
    );
  }

  if (nonEmptyString(card.openclawTarget) && !REQUIRED_TARGETS.has(card.openclawTarget)) {
    addCheck(
      checks,
      `card:${card.id}:openclawTarget`,
      "OpenClaw 落點",
      "fail",
      `不支援的 OpenClaw target: ${card.openclawTarget}`,
      card.id,
    );
  }

  const allowedTargets = TARGET_RULES[card.type];
  if (allowedTargets && !allowedTargets.has(card.openclawTarget)) {
    addCheck(
      checks,
      `card:${card.id}:target-rule`,
      "OpenClaw 落點",
      "fail",
      `${card.type} 卡不能落到 ${card.openclawTarget}`,
      card.id,
    );
  }

  for (const linkedId of card.linksTo ?? []) {
    if (!ids.has(linkedId)) {
      addCheck(
        checks,
        `card:${card.id}:link:${linkedId}`,
        "多方連結",
        "fail",
        `連到不存在的卡片: ${linkedId}`,
        card.id,
      );
    }
    if (linkedId === card.id) {
      addCheck(checks, `card:${card.id}:self-link`, "多方連結", "fail", "不能只連到自己", card.id);
    }
  }

  if (card.unsafeRealApiWrite === true) {
    addCheck(
      checks,
      `card:${card.id}:unsafe`,
      "安全阻擋",
      "fail",
      "卡片宣告真實 API 寫入風險，必須阻擋",
      card.id,
    );
  }

  if (card.standaloneHelper === true || card.openclawNative === false) {
    addCheck(
      checks,
      `card:${card.id}:openclaw-native`,
      "OpenClaw 化",
      "fail",
      "卡片只能描述 OpenClaw native surface，不能是孤立 helper",
      card.id,
    );
  }

  if (card.paidOnly === true && card.openFallback !== true) {
    addCheck(
      checks,
      `card:${card.id}:paid-only`,
      "替代方案",
      "fail",
      "paid-only 卡片缺少 openFallback",
      card.id,
    );
  }

  if (card.type === "component") {
    validateComponentShape(checks, card);
  }
}

function validateComponentShape(checks, card) {
  if (!nonEmptyString(card.componentRole)) {
    addCheck(
      checks,
      `card:${card.id}:componentRole`,
      "原架構組件",
      "fail",
      "Component Card 必須標出 componentRole",
      card.id,
    );
  }

  if (!nonEmptyStringArray(card.componentPaths)) {
    addCheck(
      checks,
      `card:${card.id}:componentPaths`,
      "原架構組件",
      "fail",
      "Component Card 必須標出 componentPaths",
      card.id,
    );
  }

  if (card.componentRole === "trading-runtime" && card.unsafeRealApiWrite === true) {
    addCheck(
      checks,
      `card:${card.id}:trading-live-write`,
      "交易安全閘門",
      "fail",
      "Trading runtime component 不能宣告真實 API 寫入",
      card.id,
    );
  }
}

async function validateComponentPaths(repoRoot, checks, card) {
  if (card.type !== "component") {
    return;
  }
  for (const componentPath of card.componentPaths ?? []) {
    if (await repoPathExists(repoRoot, componentPath)) {
      continue;
    }
    addCheck(
      checks,
      `card:${card.id}:componentPath:${componentPath}`,
      "原架構組件",
      "fail",
      `Component path 不存在或越界: ${componentPath}`,
      card.id,
    );
  }
}

async function collectCardValidationChecks(repoRoot, cards) {
  const checks = [];
  const ids = new Set();
  for (const card of cards) {
    if (ids.has(card.id)) {
      addCheck(
        checks,
        `card:${card.id}:duplicate`,
        "卡片 ID",
        "fail",
        `重複 card id: ${card.id}`,
        card.id,
      );
    }
    if (nonEmptyString(card.id)) {
      ids.add(card.id);
    }
  }

  for (const card of cards) {
    validateCardShape(checks, card, ids);
    await validateSourceUrls(repoRoot, checks, card);
    await validateComponentPaths(repoRoot, checks, card);
  }

  validateCoverage(checks, cards);
  validateArchitectureWorldModelStudySource(checks, cards);
  validateGraph(checks, cards);
  validateComponentCoverage(checks, cards);
  validateComponentLinks(checks, cards);
  return checks;
}

function validateCoverage(checks, cards) {
  const types = new Set(cards.map((card) => card.type));
  const targets = new Set(cards.map((card) => card.openclawTarget));
  const ids = new Set(cards.map((card) => card.id));

  for (const type of REQUIRED_TYPES) {
    if (!types.has(type)) {
      addCheck(checks, `coverage:type:${type}`, "卡片類型覆蓋", "fail", `缺少 ${type} 卡`);
    }
  }

  for (const target of REQUIRED_TARGETS) {
    if (!targets.has(target)) {
      addCheck(
        checks,
        `coverage:target:${target}`,
        "OpenClaw 落點覆蓋",
        "fail",
        `缺少 ${target} target`,
      );
    }
  }

  for (const id of REQUIRED_CARD_IDS) {
    if (!ids.has(id)) {
      addCheck(
        checks,
        `coverage:card:${id}`,
        "建築學 / World Model / 3D 視界覆蓋",
        "fail",
        `缺少必要卡片: ${id}`,
      );
    }
  }
}

function validateArchitectureWorldModelStudySource(checks, cards) {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  for (const id of REQUIRED_CARD_IDS) {
    const card = cardsById.get(id);
    if (!card) {
      continue;
    }
    if (card.sourceUrls?.includes(ARCHITECTURE_WORLD_MODEL_STUDY_PATH)) {
      continue;
    }
    addCheck(
      checks,
      `coverage:architecture-world-model-study:${id}`,
      "建築學 / World Model / 3D 視界開源查證",
      "fail",
      `必要卡片未連回開源查證報告: ${ARCHITECTURE_WORLD_MODEL_STUDY_PATH}`,
      id,
    );
  }
}

function validateComponentCoverage(checks, cards) {
  const componentRoles = new Set(
    cards
      .filter((card) => card.type === "component")
      .map((card) => card.componentRole)
      .filter(nonEmptyString),
  );

  for (const role of REQUIRED_COMPONENT_ROLES) {
    if (!componentRoles.has(role)) {
      addCheck(
        checks,
        `coverage:component-role:${role}`,
        "原架構組件覆蓋",
        "fail",
        `缺少原架構 Component Card: ${role}`,
      );
    }
  }
}

function validateComponentLinks(checks, cards) {
  const componentCards = cards.filter((card) => card.type === "component");
  const roleToIds = new Map();
  const idToRole = new Map();

  for (const card of componentCards) {
    if (!nonEmptyString(card.componentRole)) {
      continue;
    }
    roleToIds.set(card.componentRole, [...(roleToIds.get(card.componentRole) ?? []), card.id]);
    idToRole.set(card.id, card.componentRole);
  }

  for (const rule of REQUIRED_COMPONENT_LINKS) {
    for (const fromId of roleToIds.get(rule.fromRole) ?? []) {
      const fromCard = componentCards.find((card) => card.id === fromId);
      const linkedRoles = new Set(
        (fromCard?.linksTo ?? []).map((linkedId) => idToRole.get(linkedId)),
      );
      for (const toRole of rule.toRoles) {
        if (!linkedRoles.has(toRole)) {
          addCheck(
            checks,
            `component-link:${rule.fromRole}->${toRole}`,
            "原架構串接連結",
            "fail",
            `${rule.fromRole} 必須連到 ${toRole}`,
            fromId,
          );
        }
      }
    }
  }
}

function validateGraph(checks, cards) {
  const ids = new Set(cards.map((card) => card.id));
  const adjacency = new Map(cards.map((card) => [card.id, new Set()]));
  let multiLinkCards = 0;

  for (const card of cards) {
    if ((card.linksTo ?? []).length >= 2) {
      multiLinkCards += 1;
    }
    for (const linkedId of card.linksTo ?? []) {
      if (!ids.has(linkedId) || linkedId === card.id) {
        continue;
      }
      adjacency.get(card.id)?.add(linkedId);
      adjacency.get(linkedId)?.add(card.id);
    }
  }

  if (multiLinkCards < 2) {
    addCheck(
      checks,
      "graph:multi-link",
      "多方連結",
      "fail",
      "至少需要兩張卡連到兩個以上節點，否則不是多方連結框架",
    );
  }

  if (cards.length === 0) {
    addCheck(checks, "graph:empty", "多方連結", "fail", "卡片 registry 不能是空的");
    return;
  }

  const visited = new Set();
  const queue = [cards[0].id];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) {
      continue;
    }
    visited.add(id);
    for (const nextId of adjacency.get(id) ?? []) {
      if (!visited.has(nextId)) {
        queue.push(nextId);
      }
    }
  }

  if (visited.size !== cards.length) {
    const orphanIds = cards.map((card) => card.id).filter((id) => !visited.has(id));
    addCheck(
      checks,
      "graph:connected",
      "多方連結",
      "fail",
      `卡片圖未連通: ${orphanIds.join(", ")}`,
    );
  }
}

async function validateBuilderSkill(repoRoot, checks) {
  const skillPath = path.join(repoRoot, BUILDER_SKILL_PATH);
  let text;
  try {
    text = await fs.readFile(skillPath, "utf8");
  } catch (error) {
    addCheck(
      checks,
      "builder-skill:exists",
      "製作入口 skill",
      "fail",
      `${BUILDER_SKILL_PATH} 不存在，未來製作不會先卡片化: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  for (const term of BUILDER_SKILL_TERMS) {
    if (!text.includes(term)) {
      addCheck(
        checks,
        `builder-skill:term:${term}`,
        "製作入口 skill",
        "fail",
        `缺少必要流程詞: ${term}`,
      );
    }
  }
}

async function validateControlledRunnerPreflight(repoRoot, checks) {
  const runnerPath = path.join(repoRoot, "scripts", "openclaw-controlled-task-runner.mjs");
  let text;
  try {
    text = await fs.readFile(runnerPath, "utf8");
  } catch (error) {
    addCheck(
      checks,
      "runner-preflight:exists",
      "Controlled runner preflight",
      "fail",
      `scripts/openclaw-controlled-task-runner.mjs 不存在，卡片化無法成為任務入口硬閘: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  for (const term of CONTROLLED_RUNNER_PREFLIGHT_TERMS) {
    if (!text.includes(term)) {
      addCheck(
        checks,
        `runner-preflight:term:${term}`,
        "Controlled runner preflight",
        "fail",
        `controlled runner 缺少卡片化 preflight 必要詞: ${term}`,
      );
    }
  }
}

function createSimulationCard(overrides = {}) {
  return {
    id: "source-card",
    type: "source",
    title: "Source card",
    summary: "Source evidence for future cardized module work.",
    sourceUrls: ["docs/automation/autonomous-runtime.md"],
    openclawTarget: "docs",
    inputs: ["request"],
    outputs: ["evidence"],
    contract: "source card must point at official evidence",
    risk: ["missing source"],
    validation: ["pnpm autonomous:inventory:check"],
    rollbackPath: "remove card",
    nextSafeTask: "create capability card",
    linksTo: ["capability-card", "validation-card"],
    humanReadableCheck: "使用者可看到來源與下一步。",
    ...overrides,
  };
}

function createArchitectureComponentCard({
  id,
  title,
  componentRole,
  componentPaths,
  openclawTarget = "runtime",
  linksTo,
  sourceUrls = ["docs/automation/module-skill-inventory.md"],
  validation = ["pnpm autonomous:inventory:check"],
  risk = ["component drift"],
} = {}) {
  return createSimulationCard({
    id,
    type: "component",
    title,
    summary: `${title} is tracked as an original OpenClaw architecture component.`,
    sourceUrls,
    openclawTarget,
    inputs: ["upstream component state"],
    outputs: ["downstream component contract"],
    contract: `${componentRole} component must keep declared paths, links, validation, rollback, and next safe task`,
    risk,
    validation,
    rollbackPath: `revert ${componentRole} component card`,
    nextSafeTask: `validate ${componentRole} component links`,
    linksTo,
    humanReadableCheck: `使用者可以看到 ${componentRole} 的原架構位置、串接與驗證。`,
    componentRole,
    componentPaths,
  });
}

function createPassingArchitectureComponentCards() {
  return [
    createArchitectureComponentCard({
      id: "component-gateway",
      title: "Gateway component",
      componentRole: "gateway",
      componentPaths: ["src/gateway"],
      linksTo: ["component-channel", "component-plugin-loader", "contract-card"],
    }),
    createArchitectureComponentCard({
      id: "component-channel",
      title: "Channel component",
      componentRole: "channel",
      componentPaths: ["src/channels"],
      openclawTarget: "plugin",
      linksTo: ["component-gateway", "component-plugin-loader", "validation-card"],
    }),
    createArchitectureComponentCard({
      id: "component-plugin-loader",
      title: "Plugin loader component",
      componentRole: "plugin-loader",
      componentPaths: ["src/plugins"],
      openclawTarget: "plugin",
      sourceUrls: ["docs/tools/plugin.md"],
      linksTo: ["component-plugin-sdk", "component-extension", "validation-card"],
    }),
    createArchitectureComponentCard({
      id: "component-plugin-sdk",
      title: "Plugin SDK component",
      componentRole: "plugin-sdk",
      componentPaths: ["src/plugin-sdk"],
      linksTo: ["component-plugin-loader", "component-extension", "contract-card"],
    }),
    createArchitectureComponentCard({
      id: "component-extension",
      title: "Extension component",
      componentRole: "extension",
      componentPaths: ["extensions"],
      openclawTarget: "plugin",
      linksTo: ["component-plugin-loader", "component-plugin-sdk", "validation-card"],
    }),
    createArchitectureComponentCard({
      id: "component-skill",
      title: "Skill component",
      componentRole: "skill",
      componentPaths: ["skills"],
      openclawTarget: "skill",
      sourceUrls: ["docs/tools/skills.md"],
      linksTo: ["component-controlled-runner", "validation-card", "report-card"],
    }),
    createArchitectureComponentCard({
      id: "component-controlled-runner",
      title: "Controlled runner component",
      componentRole: "controlled-runner",
      componentPaths: ["scripts/openclaw-controlled-task-runner.mjs"],
      linksTo: ["component-taskflow", "component-validation-gate", "component-report-state"],
    }),
    createArchitectureComponentCard({
      id: "component-taskflow",
      title: "Task Flow component",
      componentRole: "taskflow",
      componentPaths: ["docs/automation/taskflow.md"],
      openclawTarget: "taskflow",
      sourceUrls: ["docs/automation/taskflow.md"],
      linksTo: [
        "component-controlled-runner",
        "component-scheduler-hooks",
        "component-report-state",
      ],
    }),
    createArchitectureComponentCard({
      id: "component-scheduler-hooks",
      title: "Scheduler and hooks component",
      componentRole: "scheduler-hooks",
      componentPaths: ["src/cron", "src/hooks"],
      linksTo: ["component-controlled-runner", "component-taskflow", "component-validation-gate"],
    }),
    createArchitectureComponentCard({
      id: "component-memory",
      title: "Memory component",
      componentRole: "memory",
      componentPaths: ["src/memory"],
      linksTo: ["component-report-state", "component-validation-gate", "contract-card"],
    }),
    createArchitectureComponentCard({
      id: "component-ui-surface",
      title: "UI surface component",
      componentRole: "ui-surface",
      componentPaths: ["ui"],
      openclawTarget: "plugin",
      linksTo: ["component-gateway", "component-report-state", "validation-card"],
    }),
    createArchitectureComponentCard({
      id: "component-config",
      title: "Config component",
      componentRole: "config",
      componentPaths: ["config"],
      linksTo: ["component-gateway", "component-validation-gate", "contract-card"],
    }),
    createArchitectureComponentCard({
      id: "component-validation-gate",
      title: "Validation gate component",
      componentRole: "validation-gate",
      componentPaths: ["scripts/check-openclaw-card-framework.mjs"],
      linksTo: ["validation-card", "component-report-state", "component-controlled-runner"],
    }),
    createArchitectureComponentCard({
      id: "component-report-state",
      title: "Report and state component",
      componentRole: "report-state",
      componentPaths: ["reports"],
      openclawTarget: "docs",
      linksTo: ["report-card", "component-validation-gate", "component-memory"],
    }),
    createArchitectureComponentCard({
      id: "component-trading-runtime",
      title: "Trading runtime component",
      componentRole: "trading-runtime",
      componentPaths: ["scripts/openclaw-capital-paper-automation-loop.mjs"],
      validation: ["pnpm capital-hft:auto-trading-loop:check"],
      risk: ["live trading must stay blocked", "broker write must stay disabled"],
      linksTo: [
        "component-trading-risk-gate",
        "component-validation-gate",
        "component-report-state",
      ],
    }),
    createArchitectureComponentCard({
      id: "component-trading-risk-gate",
      title: "Trading risk gate component",
      componentRole: "trading-risk-gate",
      componentPaths: ["scripts/check-capital-paper-automation-loop.mjs"],
      validation: ["pnpm capital-hft:capital:simulation:1000:check"],
      risk: ["paper-only gate could be bypassed if this link is removed"],
      linksTo: ["component-validation-gate", "component-report-state", "component-trading-runtime"],
    }),
  ];
}

function createPassingSimulationCards() {
  return [
    createSimulationCard(),
    createSimulationCard({
      id: "capability-card",
      type: "capability",
      sourceUrls: ["docs/tools/skills.md"],
      openclawTarget: "skill",
      contract: "capability card maps repeated procedure to skill",
      linksTo: ["module-plugin-card", "contract-card", "validation-card"],
    }),
    createSimulationCard({
      id: "module-plugin-card",
      type: "module",
      sourceUrls: ["docs/tools/plugin.md"],
      openclawTarget: "plugin",
      contract: "external connection goes through plugin manifest and runtime inspect",
      linksTo: ["contract-card", "validation-card"],
    }),
    createSimulationCard({
      id: "module-taskflow-card",
      type: "module",
      sourceUrls: ["docs/automation/taskflow.md"],
      openclawTarget: "taskflow",
      contract: "durable multi-step flow goes through Task Flow",
      linksTo: ["contract-card", "report-card"],
    }),
    createSimulationCard({
      id: "contract-card",
      type: "contract",
      sourceUrls: ["docs/automation/module-skill-inventory.md"],
      openclawTarget: "runtime",
      contract: "target contract must be docs | skill | plugin | runtime | taskflow",
      linksTo: ["validation-card", "report-card"],
    }),
    createSimulationCard({
      id: "validation-card",
      type: "validation",
      sourceUrls: ["scripts/check-openclaw-card-framework.mjs"],
      openclawTarget: "runtime",
      contract: "gate must fail invalid cards and pass valid cards",
      linksTo: ["report-card", "source-card"],
    }),
    createSimulationCard({
      id: "report-card",
      type: "report",
      sourceUrls: ["reports/openclaw-card-framework-simulation-latest.md"],
      openclawTarget: "docs",
      contract: "operator report must show accepted, blocked, falseAccepted, falseBlocked",
      linksTo: ["source-card", "validation-card"],
    }),
    createSimulationCard({
      id: "source-architecture-as-code-standards",
      type: "source",
      title: "Architecture-as-code source",
      sourceUrls: [
        "https://arc42.org/",
        "https://c4model.com/",
        "https://docs.structurizr.com/as-code",
        ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
      ],
      openclawTarget: "docs",
      contract: "architecture knowledge must be source-linked and generated from registry",
      linksTo: [
        "module-architecture-model-as-code",
        "contract-architecture-world-model-drift-gate",
        "validation-card",
      ],
    }),
    createSimulationCard({
      id: "module-architecture-model-as-code",
      type: "module",
      title: "Architecture model as code",
      sourceUrls: ["https://docs.structurizr.com/as-code", ARCHITECTURE_WORLD_MODEL_STUDY_PATH],
      openclawTarget: "runtime",
      contract: "architecture slices must be regenerated from card registry and checked for drift",
      validation: ["node --check scripts/render-openclaw-card-framework-slices.mjs"],
      linksTo: [
        "component-validation-gate",
        "component-report-state",
        "contract-architecture-world-model-drift-gate",
        "validation-card",
      ],
    }),
    createSimulationCard({
      id: "source-world-model-simulation-standards",
      type: "source",
      title: "World model source",
      sourceUrls: [
        "https://worldmodels.github.io/",
        "https://github.com/danijar/dreamerv3",
        ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
      ],
      openclawTarget: "docs",
      contract: "world model knowledge simulates future states but cannot bypass gates",
      linksTo: [
        "module-world-model-simulation-gate",
        "contract-architecture-world-model-drift-gate",
        "component-memory",
        "validation-card",
      ],
    }),
    createSimulationCard({
      id: "module-world-model-simulation-gate",
      type: "module",
      title: "World model simulation gate",
      sourceUrls: [
        "https://worldmodels.github.io/",
        ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
        "reports/openclaw-card-framework-simulation-latest.md",
      ],
      openclawTarget: "runtime",
      contract:
        "simulation must fail closed on missing source, broken architecture link, or trading-risk-gate bypass",
      validation: ["pnpm check:openclaw-card-framework"],
      linksTo: [
        "component-validation-gate",
        "component-report-state",
        "component-trading-risk-gate",
        "component-memory",
        "validation-card",
      ],
    }),
    createSimulationCard({
      id: "contract-architecture-world-model-drift-gate",
      type: "contract",
      title: "Architecture world model drift gate",
      sourceUrls: [
        "https://docs.structurizr.com/as-code",
        "https://worldmodels.github.io/",
        ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
      ],
      openclawTarget: "runtime",
      contract:
        "architecture/world-model additions must connect to validation, report, and trading-risk-gate",
      validation: ["pnpm check:openclaw-card-framework"],
      linksTo: ["validation-card", "report-card", "component-trading-risk-gate"],
    }),
    createSimulationCard({
      id: "source-3d-viewpoint-node-graph-standards",
      type: "source",
      title: "3D viewpoint node graph source",
      sourceUrls: [
        "https://threejs.org/docs/#manual/en/introduction/Creating-a-scene",
        "https://threejs.org/docs/api/en/core/Raycaster.html",
        "https://github.com/vasturiano/3d-force-graph",
        ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
      ],
      openclawTarget: "docs",
      contract: "3D viewpoint knowledge must map card ids to nodes, links, picking, and fallback",
      validation: ["pnpm check:openclaw-card-framework"],
      linksTo: [
        "module-3d-viewpoint-node-model",
        "contract-3d-viewpoint-node-graph-gate",
        "module-architecture-model-as-code",
        "validation-card",
      ],
    }),
    createSimulationCard({
      id: "module-3d-viewpoint-node-model",
      type: "module",
      title: "3D viewpoint node model",
      sourceUrls: [
        "https://github.com/vasturiano/3d-force-graph",
        "https://github.com/lagodiuk/3D-knowledge-graph",
        ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
        "reports/openclaw-card-framework-simulation-latest.md",
      ],
      openclawTarget: "runtime",
      contract:
        "3D node graph must be regenerated from card registry and keep source/report fallback",
      validation: [
        "node --check scripts/render-openclaw-card-framework-slices.mjs",
        "pnpm check:openclaw-card-framework",
      ],
      linksTo: [
        "component-ui-surface",
        "component-validation-gate",
        "component-report-state",
        "module-architecture-model-as-code",
        "module-world-model-simulation-gate",
        "contract-3d-viewpoint-node-graph-gate",
        "validation-card",
      ],
    }),
    createSimulationCard({
      id: "contract-3d-viewpoint-node-graph-gate",
      type: "contract",
      title: "3D viewpoint node graph gate",
      sourceUrls: [
        "https://threejs.org/docs/api/en/core/Raycaster.html",
        "https://github.com/vasturiano/3d-force-graph",
        ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
      ],
      openclawTarget: "runtime",
      contract:
        "3D viewpoint graph must preserve card ids, validation/report links, 2D fallback, and risk gates",
      validation: ["pnpm check:openclaw-card-framework"],
      linksTo: [
        "validation-card",
        "report-card",
        "component-ui-surface",
        "component-trading-risk-gate",
      ],
    }),
    ...createPassingArchitectureComponentCards(),
  ];
}

function mutateSimulationCards(mutator) {
  const cards = createPassingSimulationCards();
  mutator(cards);
  return cards;
}

const SIMULATION_SCENARIOS = [
  {
    name: "valid-linked-registry",
    expected: "accept",
    createCards: createPassingSimulationCards,
  },
  {
    name: "missing-source-evidence",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        cards[0].sourceUrls = ["docs/does-not-exist.md"];
      }),
  },
  {
    name: "outside-root-source",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        cards[0].sourceUrls = ["../outside.md"];
      }),
  },
  {
    name: "missing-links",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        cards[0].linksTo = [];
      }),
  },
  {
    name: "standalone-helper-only",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        cards[2].standaloneHelper = true;
      }),
  },
  {
    name: "wrong-target",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        cards[1].openclawTarget = "plugin";
      }),
  },
  {
    name: "unsafe-real-api-write",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        cards[2].unsafeRealApiWrite = true;
      }),
  },
  {
    name: "missing-architecture-world-model-study-source",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        const card = cards.find((entry) => entry.id === "module-world-model-simulation-gate");
        card.sourceUrls = card.sourceUrls.filter(
          (sourceUrl) => sourceUrl !== ARCHITECTURE_WORLD_MODEL_STUDY_PATH,
        );
      }),
  },
  {
    name: "missing-3d-viewpoint-node-model",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        const index = cards.findIndex((card) => card.id === "module-3d-viewpoint-node-model");
        if (index >= 0) {
          cards.splice(index, 1);
        }
      }),
  },
  {
    name: "missing-validation",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        cards[5].validation = [];
      }),
  },
  {
    name: "paid-only-without-fallback",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        cards[1].paidOnly = true;
      }),
  },
  {
    name: "missing-contract",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        cards[4].contract = "";
      }),
  },
  {
    name: "original-component-graph-valid",
    expected: "accept",
    createCards: createPassingSimulationCards,
  },
  {
    name: "missing-original-component-role",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        const index = cards.findIndex((card) => card.componentRole === "gateway");
        if (index >= 0) {
          cards.splice(index, 1);
        }
      }),
  },
  {
    name: "missing-original-component-path",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        const component = cards.find((card) => card.componentRole === "gateway");
        component.componentPaths = ["src/not-a-real-gateway"];
      }),
  },
  {
    name: "trading-runtime-without-risk-gate-link",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        const component = cards.find((card) => card.componentRole === "trading-runtime");
        component.linksTo = ["component-validation-gate", "component-report-state"];
      }),
  },
  {
    name: "trading-runtime-live-write-risk",
    expected: "block",
    createCards: () =>
      mutateSimulationCards((cards) => {
        const component = cards.find((card) => card.componentRole === "trading-runtime");
        component.unsafeRealApiWrite = true;
      }),
  },
];

async function runDeterministicSimulation(repoRoot, iterations = 1000) {
  let acceptedCorrect = 0;
  let blockedIncorrect = 0;
  let falseAccepted = 0;
  let falseBlocked = 0;
  const byCase = {};

  for (let index = 0; index < iterations; index += 1) {
    const scenario = SIMULATION_SCENARIOS[index % SIMULATION_SCENARIOS.length];
    const scenarioChecks = await collectCardValidationChecks(repoRoot, scenario.createCards());
    const failedChecks = scenarioChecks.filter((check) => check.status === "fail");
    const decision = failedChecks.length === 0 ? "accept" : "block";
    const ok = decision === scenario.expected;

    if (scenario.expected === "accept" && decision === "accept") {
      acceptedCorrect += 1;
    } else if (scenario.expected === "block" && decision === "block") {
      blockedIncorrect += 1;
    } else if (scenario.expected === "block" && decision === "accept") {
      falseAccepted += 1;
    } else {
      falseBlocked += 1;
    }

    byCase[scenario.name] ??= {
      count: 0,
      correct: 0,
      expected: scenario.expected,
      decision,
      sampleBlockReasons: [],
    };
    byCase[scenario.name].count += 1;
    byCase[scenario.name].correct += ok ? 1 : 0;
    byCase[scenario.name].decision = decision;
    if (failedChecks.length > 0 && byCase[scenario.name].sampleBlockReasons.length === 0) {
      byCase[scenario.name].sampleBlockReasons = failedChecks.slice(0, 5).map((check) => check.id);
    }
  }

  const correct = acceptedCorrect + blockedIncorrect;
  const mismatches = falseAccepted + falseBlocked;
  return {
    iterations,
    correct,
    mismatches,
    acceptedCorrect,
    blockedIncorrect,
    falseAccepted,
    falseBlocked,
    ok: mismatches === 0,
    byCase,
  };
}

function summarize(checks, cards, simulation) {
  const failed = checks.filter((check) => check.status === "fail").length;
  const passed = checks.length - failed;
  const architectureImpact = summarizeArchitectureImpact(checks, cards, simulation);
  return {
    ok: failed === 0 && simulation.ok && architectureImpact.ok,
    total: checks.length,
    passed,
    failed,
    cards: cards.length,
    simulation,
    architectureImpact,
  };
}

function summarizeArchitectureImpact(checks, cards, simulation) {
  const failures = checks.filter((check) => check.status === "fail");
  const missingComponentRoles = failures
    .filter((check) => check.id.startsWith("coverage:component-role:"))
    .map((check) => check.id.slice("coverage:component-role:".length));
  const missingComponentPaths = failures
    .filter((check) => check.id.includes(":componentPath:"))
    .map((check) => check.id);
  const brokenComponentLinks = failures
    .filter((check) => check.id.startsWith("component-link:"))
    .map((check) => check.id.slice("component-link:".length));
  const runnerPreflightFailures = failures
    .filter((check) => check.id.startsWith("runner-preflight:"))
    .map((check) => check.id);
  const tradingRuntime = cards.find(
    (card) => card.type === "component" && card.componentRole === "trading-runtime",
  );
  const tradingRiskGate = cards.find(
    (card) => card.type === "component" && card.componentRole === "trading-risk-gate",
  );
  const tradingRuntimeLinkedToRiskGate =
    Array.isArray(tradingRuntime?.linksTo) && tradingRuntime.linksTo.includes(tradingRiskGate?.id);
  const tradingRiskGateLinkedToValidationAndReport =
    Array.isArray(tradingRiskGate?.linksTo) &&
    tradingRiskGate.linksTo.includes("component-validation-gate") &&
    tradingRiskGate.linksTo.includes("component-report-state");
  const protectedComponentRoles = new Set(
    cards
      .filter((card) => card.type === "component")
      .map((card) => card.componentRole)
      .filter(nonEmptyString),
  );
  const guardedBreakCases = [
    "missing-original-component-role",
    "missing-original-component-path",
    "trading-runtime-without-risk-gate-link",
    "trading-runtime-live-write-risk",
    "missing-3d-viewpoint-node-model",
  ];
  const guardedBreakCaseStatus = Object.fromEntries(
    guardedBreakCases.map((name) => [
      name,
      simulation.byCase?.[name]?.decision === "block" &&
        simulation.byCase?.[name]?.expected === "block",
    ]),
  );
  const ok =
    missingComponentRoles.length === 0 &&
    missingComponentPaths.length === 0 &&
    brokenComponentLinks.length === 0 &&
    runnerPreflightFailures.length === 0 &&
    tradingRuntimeLinkedToRiskGate &&
    tradingRiskGateLinkedToValidationAndReport &&
    Object.values(guardedBreakCaseStatus).every(Boolean);

  return {
    ok,
    protectedComponents: protectedComponentRoles.size,
    requiredComponents: REQUIRED_COMPONENT_ROLES.size,
    missingComponentRoles,
    missingComponentPaths,
    brokenComponentLinks,
    runnerPreflightEnforced: runnerPreflightFailures.length === 0,
    runnerPreflightFailures,
    tradingRuntimeLinkedToRiskGate,
    tradingRiskGateLinkedToValidationAndReport,
    guardedBreakCaseStatus,
  };
}

function collectCoverage(cards) {
  const byType = {};
  const byTarget = {};
  const byComponentRole = {};
  for (const card of cards) {
    byType[card.type] = (byType[card.type] ?? 0) + 1;
    byTarget[card.openclawTarget] = (byTarget[card.openclawTarget] ?? 0) + 1;
    if (card.type === "component" && nonEmptyString(card.componentRole)) {
      byComponentRole[card.componentRole] = (byComponentRole[card.componentRole] ?? 0) + 1;
    }
  }
  return { byType, byTarget, byComponentRole };
}

function formatHumanReport(report) {
  const lines = [
    "OpenClaw 卡片式框架查驗",
    `Repo: ${report.repoRoot}`,
    `Registry: ${report.registryPath}`,
    `Summary: ${report.summary.ok ? "PASS" : "FAIL"} (${report.summary.passed}/${report.summary.total} checks, cards=${report.summary.cards})`,
    `1000 次模擬: ${report.summary.simulation.correct}/${report.summary.simulation.iterations}, mismatches=${report.summary.simulation.mismatches}`,
    `正確接受/錯誤排除: acceptedCorrect=${report.summary.simulation.acceptedCorrect}, blockedIncorrect=${report.summary.simulation.blockedIncorrect}, falseAccepted=${report.summary.simulation.falseAccepted}, falseBlocked=${report.summary.simulation.falseBlocked}`,
    `Type coverage: ${Object.entries(report.coverage.byType)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`,
    `Target coverage: ${Object.entries(report.coverage.byTarget)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`,
    `Component coverage: ${Object.entries(report.coverage.byComponentRole)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`,
    `原架構卡片化模擬: ${report.summary.architectureImpact.ok ? "PASS" : "FAIL"} protectedComponents=${report.summary.architectureImpact.protectedComponents}/${report.summary.architectureImpact.requiredComponents}, runnerPreflight=${report.summary.architectureImpact.runnerPreflightEnforced ? "enforced" : "missing"}, tradingRiskGate=${report.summary.architectureImpact.tradingRuntimeLinkedToRiskGate && report.summary.architectureImpact.tradingRiskGateLinkedToValidationAndReport ? "enforced" : "broken"}`,
    `破壞情境排除: ${Object.entries(report.summary.architectureImpact.guardedBreakCaseStatus)
      .map(([key, value]) => `${key}=${value ? "blocked" : "NOT_BLOCKED"}`)
      .join(", ")}`,
  ];

  for (const check of report.checks) {
    const mark = check.status === "pass" ? "[PASS]" : "[FAIL]";
    const cardPart = check.cardId ? ` (${check.cardId})` : "";
    lines.push(`${mark} ${check.label}${cardPart} - ${check.message}`);
  }

  if (!report.summary.ok) {
    lines.push(
      "修正方式: 補齊來源、linksTo、contract、validation、OpenClaw target 或 readable check 後重跑 gate。",
    );
  }

  return lines.join("\n");
}

export async function collectCardFrameworkReport({
  repoRoot = process.cwd(),
  registryPath = DEFAULT_REGISTRY_PATH,
  simulationIterations = 1000,
} = {}) {
  const normalizedRoot = path.resolve(repoRoot);
  const normalizedRegistryPath = toRepoPath(registryPath);
  const registryAbsolutePath = path.join(normalizedRoot, normalizedRegistryPath);
  const checks = [];
  let registry;

  try {
    registry = JSON.parse(await fs.readFile(registryAbsolutePath, "utf8"));
  } catch (error) {
    addCheck(
      checks,
      "registry:read",
      "Registry",
      "fail",
      `讀取 registry 失敗: ${error instanceof Error ? error.message : String(error)}`,
    );
    const simulation = await runDeterministicSimulation(normalizedRoot, simulationIterations);
    return {
      repoRoot: toRepoPath(normalizedRoot),
      registryPath: normalizedRegistryPath,
      checks,
      cards: [],
      coverage: { byType: {}, byTarget: {}, byComponentRole: {} },
      summary: summarize(checks, [], simulation),
    };
  }

  if (!isRecord(registry)) {
    addCheck(checks, "registry:shape", "Registry", "fail", "registry 必須是 JSON object");
    const simulation = await runDeterministicSimulation(normalizedRoot, simulationIterations);
    return {
      repoRoot: toRepoPath(normalizedRoot),
      registryPath: normalizedRegistryPath,
      checks,
      cards: [],
      coverage: { byType: {}, byTarget: {}, byComponentRole: {} },
      summary: summarize(checks, [], simulation),
    };
  }

  const cards = Array.isArray(registry.cards) ? registry.cards.filter(isRecord) : [];
  if (registry.schemaVersion !== 1) {
    addCheck(checks, "registry:schemaVersion", "Registry", "fail", "schemaVersion 必須是 1");
  }
  if (registry.framework !== "openclaw-card-framework") {
    addCheck(
      checks,
      "registry:framework",
      "Registry",
      "fail",
      "framework 必須是 openclaw-card-framework",
    );
  }
  if (!Array.isArray(registry.cards)) {
    addCheck(checks, "registry:cards", "Registry", "fail", "cards 必須是 array");
  }

  checks.push(...(await collectCardValidationChecks(normalizedRoot, cards)));
  await validateBuilderSkill(normalizedRoot, checks);
  await validateControlledRunnerPreflight(normalizedRoot, checks);

  if (checks.length === 0) {
    addCheck(
      checks,
      "registry:complete",
      "使用者可讀查驗",
      "pass",
      "卡片 schema、多方連結、OpenClaw target 與可讀驗證都完整",
    );
  }

  const simulation = await runDeterministicSimulation(normalizedRoot, simulationIterations);
  if (!simulation.ok) {
    addCheck(
      checks,
      "simulation:1000",
      "1000 次模擬",
      "fail",
      `模擬不一致: ${simulation.mismatches}`,
    );
  } else {
    addCheck(checks, "simulation:1000", "1000 次模擬", "pass", "1000/1000 決策符合預期");
  }

  return {
    repoRoot: toRepoPath(normalizedRoot),
    registryPath: normalizedRegistryPath,
    checks,
    cards,
    coverage: collectCoverage(cards),
    summary: summarize(checks, cards, simulation),
  };
}

export async function runCardFrameworkCheck({
  argv = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr },
  repoRoot = process.cwd(),
  simulationIterations,
} = {}) {
  const checkMode = argv.includes("--check");
  const jsonMode = argv.includes("--json");
  const registryFlagIndex = argv.indexOf("--registry");
  const registryPath =
    registryFlagIndex >= 0 && argv[registryFlagIndex + 1]
      ? argv[registryFlagIndex + 1]
      : DEFAULT_REGISTRY_PATH;
  const report = await collectCardFrameworkReport({ repoRoot, registryPath, simulationIterations });

  if (jsonMode) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(`${formatHumanReport(report)}\n`);
  }

  if (!checkMode) {
    return 0;
  }

  if (report.summary.ok) {
    io.stdout.write("openclaw card framework check passed\n");
    return 0;
  }

  io.stderr.write("openclaw card framework check failed\n");
  for (const check of report.checks) {
    if (check.status === "fail") {
      io.stderr.write(`- ${check.id}: ${check.message}\n`);
    }
  }
  return 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (invokedPath === currentPath) {
  runCardFrameworkCheck()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `openclaw card framework check crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
