#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const registryPath = path.join(repoRoot, "reports", "openclaw-card-framework-cards.json");
const outDir = path.join(repoRoot, "reports", "openclaw-card-framework-slices");

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const cards = registry.cards ?? [];
const cardById = new Map(cards.map((card) => [card.id, card]));
const linkedBy = new Map(cards.map((card) => [card.id, []]));

for (const card of cards) {
  for (const target of card.linksTo ?? []) {
    if (linkedBy.has(target)) {
      linkedBy.get(target).push(card.id);
    }
  }
}

const allEdges = cards.flatMap((card) =>
  (card.linksTo ?? []).map((target) => ({ from: card.id, to: target })),
);

const typeColors = {
  source: "#2563eb",
  capability: "#059669",
  module: "#d97706",
  component: "#7c3aed",
  contract: "#dc2626",
  validation: "#0891b2",
  report: "#4b5563",
};

const targetFills = {
  docs: "#e0f2fe",
  skill: "#dcfce7",
  runtime: "#fef9c3",
  plugin: "#ede9fe",
  taskflow: "#fee2e2",
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function wrap(value, max = 56) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const words = text.split(/\s+/u);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if ((line + " " + word).length <= max) {
      line += " " + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function collectSliceIds(primaryIds) {
  const ids = new Set(primaryIds.filter((id) => cardById.has(id)));
  for (const id of [...ids]) {
    const card = cardById.get(id);
    for (const target of card.linksTo ?? []) {
      if (cardById.has(target)) ids.add(target);
    }
  }
  return [...ids];
}

function buildSliceEdges(primaryIds, selectedIds) {
  const selected = new Set(selectedIds);
  return primaryIds
    .filter((id) => cardById.has(id))
    .flatMap((id) => {
      const card = cardById.get(id);
      return (card.linksTo ?? [])
        .filter((target) => selected.has(target))
        .map((target) => ({ from: id, to: target }));
    });
}

function cardBlock(card, x, y, width, height, options = {}) {
  const color = typeColors[card.type] ?? "#334155";
  const fill = "#ffffff";
  const targetFill = targetFills[card.openclawTarget] ?? "#f1f5f9";
  const title = wrap(card.title, 38).slice(0, 2);
  const role = card.componentRole ? `role: ${card.componentRole}` : `type: ${card.type}`;
  const meta = `${role} | target: ${card.openclawTarget}`;
  const idLine = card.id;
  const linkLine = `out: ${(card.linksTo ?? []).length} | in: ${(linkedBy.get(card.id) ?? []).length}`;
  const validate = (card.validation ?? []).join("; ");
  const validateLines = wrap(`gate: ${validate || "none"}`, 48).slice(0, 2);
  const lines = [
    ...title.map((text, index) => ({
      text,
      size: index === 0 ? 16 : 14,
      weight: index === 0 ? 700 : 600,
      color: "#020617",
    })),
    { text: meta, size: 12, weight: 700, color },
    { text: idLine, size: 11, weight: 500, color: "#334155" },
    { text: linkLine, size: 11, weight: 600, color: "#64748b" },
    ...validateLines.map((text) => ({ text, size: 11, weight: 500, color: "#475569" })),
  ];

  let svg = `
    <g id="${esc(card.id)}">
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="10" fill="${fill}" stroke="#cbd5e1" stroke-width="1.5"/>
      <rect x="${x}" y="${y}" width="8" height="${height}" rx="4" fill="${color}"/>
      <rect x="${x + width - 92}" y="${y + 12}" width="70" height="26" rx="13" fill="${targetFill}" stroke="#cbd5e1"/>
      <text x="${x + width - 57}" y="${y + 30}" text-anchor="middle" font-size="11" font-weight="700" fill="#334155">${esc(card.openclawTarget)}</text>
  `;
  let textY = y + 28;
  for (const line of lines) {
    svg += `<text x="${x + 22}" y="${textY}" font-size="${line.size}" font-weight="${line.weight}" fill="${line.color}">${esc(line.text)}</text>`;
    textY += line.size + 7;
  }
  if (options.primary) {
    svg += `<rect x="${x + 10}" y="${y + height - 26}" width="72" height="18" rx="9" fill="#fef3c7" stroke="#f59e0b"/><text x="${x + 46}" y="${y + height - 13}" text-anchor="middle" font-size="10" font-weight="800" fill="#92400e">PRIMARY</text>`;
  }
  svg += "</g>";
  return svg;
}

function renderGraphSlice(slice) {
  const primaryIds = slice.primaryIds.filter((id) => cardById.has(id));
  const selectedIds = collectSliceIds(primaryIds);
  const edges = buildSliceEdges(primaryIds, selectedIds);
  const columns = slice.columns ?? 4;
  const cardWidth = 360;
  const cardHeight = 152;
  const colGap = 70;
  const rowGap = 42;
  const margin = 60;
  const top = 185;
  const rows = Math.ceil(selectedIds.length / columns);
  const graphHeight = top + rows * (cardHeight + rowGap) + 40;
  const edgeListRows = Math.ceil(edges.length / 3);
  const edgeTop = graphHeight + 80;
  const height = edgeTop + edgeListRows * 28 + 95;
  const width = margin * 2 + columns * cardWidth + (columns - 1) * colGap;
  const positions = new Map();

  selectedIds.forEach((id, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    positions.set(id, {
      x: margin + col * (cardWidth + colGap),
      y: top + row * (cardHeight + rowGap),
    });
  });

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      text { font-family: "Noto Sans TC", "Microsoft JhengHei", "Microsoft YaHei", Arial, sans-serif; }
    </style>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#64748b"/>
    </marker>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#94a3b8" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <text x="${margin}" y="50" font-size="34" font-weight="800" fill="#020617">${esc(slice.title)}</text>
  <text x="${margin}" y="86" font-size="16" fill="#334155">${esc(slice.subtitle)}</text>
  <text x="${margin}" y="124" font-size="15" font-weight="800" fill="#0f172a">${esc(slice.rule)}</text>
  <text x="${margin}" y="150" font-size="14" fill="#475569">primary cards: ${primaryIds.length} | visible cards: ${selectedIds.length} | visible primary outgoing links: ${edges.length}</text>
`;

  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const source = cardById.get(edge.from);
    const stroke = typeColors[source.type] ?? "#64748b";
    const x1 = from.x + cardWidth;
    const y1 = from.y + cardHeight / 2;
    const x2 = to.x;
    const y2 = to.y + cardHeight / 2;
    const dx = Math.max(50, Math.abs(x2 - x1) / 2);
    svg += `<path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="1.6" opacity="0.64" marker-end="url(#arrow)"/>`;
  }

  for (const id of selectedIds) {
    const card = cardById.get(id);
    const pos = positions.get(id);
    svg += `<g filter="url(#shadow)">${cardBlock(card, pos.x, pos.y, cardWidth, cardHeight, {
      primary: primaryIds.includes(id),
    })}</g>`;
  }

  svg += `<text x="${margin}" y="${edgeTop - 28}" font-size="24" font-weight="800" fill="#020617">Visible Links (${edges.length})</text>`;
  edges.forEach((edge, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = margin + col * ((width - margin * 2) / 3);
    const y = edgeTop + row * 28;
    const source = cardById.get(edge.from);
    svg += `<circle cx="${x + 5}" cy="${y - 4}" r="4" fill="${typeColors[source.type] ?? "#64748b"}"/><text x="${x + 18}" y="${y}" font-size="12" fill="#0f172a">${esc(edge.from)} -&gt; ${esc(edge.to)}</text>`;
  });
  svg += "\n</svg>\n";
  return svg;
}

function expandedCardHeight(card) {
  const out = card.linksTo ?? [];
  const incoming = linkedBy.get(card.id) ?? [];
  const validations = card.validation ?? [];
  const paths = card.componentPaths ?? [];
  const sourceUrls = card.sourceUrls ?? [];
  const textLines = [
    ...wrap(card.summary, 88),
    ...sourceUrls.map((source) => `source: ${source}`),
    ...paths.map((item) => `path: ${item}`),
    ...out.map((item) => `OUT linksTo -> ${item}`),
    ...incoming.map((item) => `IN linkedBy <- ${item}`),
    ...validations.map((item) => `gate: ${item}`),
  ];
  return Math.max(210, 120 + textLines.length * 20);
}

function renderExpandedIndex() {
  const columns = 2;
  const margin = 58;
  const gap = 34;
  const cardWidth = 760;
  const colHeights = Array(columns).fill(165);
  const placements = [];

  for (const card of cards) {
    const col = colHeights[0] <= colHeights[1] ? 0 : 1;
    const height = expandedCardHeight(card);
    placements.push({ card, col, x: margin + col * (cardWidth + gap), y: colHeights[col], height });
    colHeights[col] += height + 28;
  }

  const width = margin * 2 + columns * cardWidth + gap;
  const height = Math.max(...colHeights) + 70;
  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      text { font-family: "Noto Sans TC", "Microsoft JhengHei", "Microsoft YaHei", Arial, sans-serif; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <text x="${margin}" y="50" font-size="34" font-weight="800" fill="#020617">OpenClaw 單卡展開索引</text>
  <text x="${margin}" y="86" font-size="16" fill="#334155">每張卡都列出 source/path、OUT 分支、IN 反向連結、gate 驗證；沒有省略號、沒有隱藏分支。</text>
  <text x="${margin}" y="122" font-size="15" font-weight="800" fill="#0f172a">cards: ${cards.length} | total OUT links: ${allEdges.length} | registry: reports/openclaw-card-framework-cards.json</text>
`;

  for (const placement of placements) {
    const { card, x, y, height: blockHeight } = placement;
    const color = typeColors[card.type] ?? "#334155";
    svg += `
    <g id="expanded-${esc(card.id)}">
      <rect x="${x}" y="${y}" width="${cardWidth}" height="${blockHeight}" rx="10" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.4"/>
      <rect x="${x}" y="${y}" width="8" height="${blockHeight}" rx="4" fill="${color}"/>
      <text x="${x + 24}" y="${y + 32}" font-size="18" font-weight="800" fill="#020617">${esc(card.title)}</text>
      <text x="${x + 24}" y="${y + 58}" font-size="12" font-weight="800" fill="${color}">${esc(card.id)} | type=${esc(card.type)} | target=${esc(card.openclawTarget)}${card.componentRole ? ` | role=${esc(card.componentRole)}` : ""}</text>
`;
    let textY = y + 86;
    const bodyLines = [
      ...wrap(card.summary, 88).map((text) => ({ label: "summary", text })),
      ...(card.sourceUrls ?? []).map((text) => ({ label: "source", text })),
      ...(card.componentPaths ?? []).map((text) => ({ label: "path", text })),
      ...(card.linksTo ?? []).map((text) => ({ label: "OUT linksTo", text })),
      ...(linkedBy.get(card.id) ?? []).map((text) => ({ label: "IN linkedBy", text })),
      ...(card.validation ?? []).map((text) => ({ label: "gate", text })),
    ];
    for (const line of bodyLines) {
      const labelColor =
        line.label === "OUT linksTo"
          ? "#7c3aed"
          : line.label === "IN linkedBy"
            ? "#0f766e"
            : line.label === "gate"
              ? "#dc2626"
              : "#475569";
      svg += `<text x="${x + 24}" y="${textY}" font-size="12" fill="#0f172a"><tspan font-weight="800" fill="${labelColor}">${esc(line.label)}:</tspan> ${esc(line.text)}</text>`;
      textY += 20;
    }
    svg += "</g>";
  }

  svg += "\n</svg>\n";
  return svg;
}

function writeIndex(slices) {
  const lines = [
    "# OpenClaw card framework sliced visual index",
    "",
    `- cards: ${cards.length}`,
    `- full links: ${allEdges.length}`,
    `- source registry: ${path.relative(repoRoot, registryPath).replaceAll("\\", "/")}`,
    "",
    "## Slices",
  ];

  for (const slice of slices) {
    const selectedIds = collectSliceIds(slice.primaryIds);
    const edges = buildSliceEdges(slice.primaryIds, selectedIds);
    lines.push(`- ${slice.file}.svg`);
    lines.push(`  - ${slice.title}`);
    lines.push(`  - primary cards: ${slice.primaryIds.length}`);
    lines.push(`  - visible cards: ${selectedIds.length}`);
    lines.push(`  - visible primary outgoing links: ${edges.length}`);
  }

  lines.push("- 09-single-card-expanded-index.svg");
  lines.push(
    "  - every card expanded with source/path, OUT linksTo, IN linkedBy, and gate validation",
  );
  lines.push("");
  lines.push("## Full Edge Coverage");
  allEdges.forEach((edge, index) => {
    lines.push(`${index + 1}. ${edge.from} -> ${edge.to}`);
  });
  lines.push("");
  writeFileSync(path.join(outDir, "openclaw-card-slice-index.md"), lines.join("\n"), "utf8");
}

mkdirSync(outDir, { recursive: true });

const slices = [
  {
    file: "01-original-architecture-components",
    title: "Slice 01 原架構組件卡片化",
    subtitle: "原架構組件不是孤立卡；每個 component 必須有路徑、分支與 gate 連結。",
    rule: "檢查重點: gateway/channel/plugin-loader/plugin-sdk/extension/skill/runner/taskflow/scheduler/memory/ui/config/validation/report/trading",
    columns: 4,
    primaryIds: cards.filter((card) => card.type === "component").map((card) => card.id),
  },
  {
    file: "02-skill-production-branch",
    title: "Slice 02 製作入口與 Skill 分支",
    subtitle: "未來製作先卡片化，再進入 skill、controlled runner、validation、report。",
    rule: "檢查重點: source -> capability -> builder skill -> runner/gate/report",
    columns: 4,
    primaryIds: [
      "source-openclaw-official-runtime",
      "source-public-architecture-standards",
      "capability-cardized-module-production",
      "skill-openclaw-card-framework-builder",
      "component-skill",
      "component-controlled-runner",
    ],
  },
  {
    file: "03-gateway-plugin-channel-links",
    title: "Slice 03 Gateway / Plugin / Channel 串接",
    subtitle: "外部通道與多方連線必須走 Gateway、Plugin loader、Plugin SDK、Extension 邊界。",
    rule: "檢查重點: channel 不得跳過 gateway；plugin 不得繞過 SDK 與 loader",
    columns: 4,
    primaryIds: [
      "component-gateway",
      "component-channel",
      "component-plugin-loader",
      "component-plugin-sdk",
      "component-extension",
      "component-ui-surface",
      "component-config",
      "module-plugin-connection-surface",
    ],
  },
  {
    file: "04-taskflow-scheduler-runner-links",
    title: "Slice 04 Taskflow / Scheduler / Runner 流程",
    subtitle: "長流程、排程、hooks 與可恢復任務必須連到 controlled runner 與 report state。",
    rule: "檢查重點: runner -> taskflow -> scheduler/hooks -> validation/report",
    columns: 4,
    primaryIds: [
      "component-controlled-runner",
      "component-taskflow",
      "component-scheduler-hooks",
      "component-memory",
      "component-report-state",
      "module-taskflow-durable-surface",
    ],
  },
  {
    file: "05-validation-contract-report-gates",
    title: "Slice 05 Contract / Validation / Report 查驗層",
    subtitle: "使用者看得懂的驗收必須落在 contract、validation gate、operator report。",
    rule: "檢查重點: 每條製作分支最後都要能回到 gate/report，不可只靠口頭規則",
    columns: 4,
    primaryIds: [
      "contract-openclaw-target-router",
      "validation-readable-card-gate",
      "report-operator-readable-check",
      "component-validation-gate",
      "component-report-state",
      "module-openclaw-surface-router",
      "component-config",
      "component-memory",
    ],
  },
  {
    file: "06-trading-protection-branch",
    title: "Slice 06 自動交易保護分支",
    subtitle:
      "交易 runtime 必須先連 trading-risk-gate，再連 validation/report；不得直接寫入真實交易。",
    rule: "檢查重點: trading-runtime -> trading-risk-gate -> validation/report -> paper-only proof",
    columns: 4,
    primaryIds: [
      "component-trading-runtime",
      "component-trading-risk-gate",
      "component-validation-gate",
      "component-report-state",
      "validation-readable-card-gate",
      "report-operator-readable-check",
    ],
  },
  {
    file: "07-architecture-world-model-branch",
    title: "Slice 07 建築學 / World Model 分支",
    subtitle:
      "建築學來源落到 architecture-as-code；world model 只做模擬 gate，不繞過 validation 或 trading-risk-gate。",
    rule: "檢查重點: architecture source -> model-as-code -> drift gate | world-model source -> simulation gate -> validation/report/risk",
    columns: 4,
    primaryIds: [
      "source-architecture-as-code-standards",
      "module-architecture-model-as-code",
      "source-world-model-simulation-standards",
      "module-world-model-simulation-gate",
      "contract-architecture-world-model-drift-gate",
      "component-validation-gate",
      "component-report-state",
      "component-trading-risk-gate",
    ],
  },
  {
    file: "08-3d-viewpoint-node-model-branch",
    title: "Slice 08 視界 / 3D 元點模型分支",
    subtitle:
      "3D 視界只能由 card registry 生成 node/edge/view slice；點選必須回到卡片、驗證與 2D fallback。",
    rule: "檢查重點: 3D source -> node model -> graph gate -> UI/report/validation/risk，不可變成不受控執行入口",
    columns: 4,
    primaryIds: [
      "source-3d-viewpoint-node-graph-standards",
      "module-3d-viewpoint-node-model",
      "contract-3d-viewpoint-node-graph-gate",
      "component-ui-surface",
      "component-validation-gate",
      "component-report-state",
      "module-architecture-model-as-code",
      "module-world-model-simulation-gate",
      "component-trading-risk-gate",
    ],
  },
];

for (const slice of slices) {
  writeFileSync(path.join(outDir, `${slice.file}.svg`), renderGraphSlice(slice), "utf8");
}

writeFileSync(
  path.join(outDir, "09-single-card-expanded-index.svg"),
  renderExpandedIndex(),
  "utf8",
);

writeIndex(slices);

console.log(
  JSON.stringify(
    {
      ok: true,
      outDir: path.relative(repoRoot, outDir).replaceAll("\\", "/"),
      cards: cards.length,
      fullLinks: allEdges.length,
      slices: slices.length + 1,
    },
    null,
    2,
  ),
);
