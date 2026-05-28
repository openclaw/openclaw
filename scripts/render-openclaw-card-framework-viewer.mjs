#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_GRAPH_PATH = "reports/openclaw-card-framework-graph.json";
const DEFAULT_OUT_PATH = "reports/openclaw-card-framework-3d-viewer.html";

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function parseFlagValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  return fallback;
}

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function validateGraph(graph) {
  const failures = [];
  if (graph?.kind !== "openclaw-card-framework-graph") {
    failures.push("kind must be openclaw-card-framework-graph");
  }
  if (graph?.validation?.ok !== true) {
    failures.push("graph validation summary must be ok");
  }
  if (!Array.isArray(graph?.graph?.nodes) || graph.graph.nodes.length === 0) {
    failures.push("graph.nodes must be non-empty");
  }
  if (!Array.isArray(graph?.graph?.links)) {
    failures.push("graph.links must be an array");
  }
  if ((graph?.graph?.missingLinks ?? []).length > 0) {
    failures.push("graph contains missing links");
  }
  if ((graph?.graph?.duplicateNodeIds ?? []).length > 0) {
    failures.push("graph contains duplicate node ids");
  }
  if (!Array.isArray(graph?.viewpoints) || graph.viewpoints.length === 0) {
    failures.push("graph.viewpoints must be non-empty");
  }
  return failures;
}

export function buildCardFrameworkViewerHtml(graph) {
  const data = JSON.stringify(graph);
  const title = "OpenClaw Card Graph Viewer";
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --ink: #121826;
      --muted: #5f6b7a;
      --line: #c9d2df;
      --panel: #ffffff;
      --source: #2563eb;
      --component: #7c3aed;
      --capability: #059669;
      --module: #d97706;
      --contract: #dc2626;
      --validation: #0891b2;
      --report: #4b5563;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Noto Sans TC", "Microsoft JhengHei", "Segoe UI", Arial, sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      min-height: 100vh;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 22px 14px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
      font-size: 12px;
      color: var(--muted);
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 9px;
      background: #f8fafc;
      white-space: nowrap;
    }
    main {
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      padding: 12px 22px;
      border-bottom: 1px solid var(--line);
      background: #eef2f7;
    }
    select, input[type="range"], button {
      font: inherit;
    }
    select {
      min-width: 230px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 7px 9px;
      background: #ffffff;
      color: var(--ink);
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--muted);
    }
    input[type="range"] {
      width: 150px;
      accent-color: #334155;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 7px 10px;
      color: var(--ink);
      background: #ffffff;
      cursor: pointer;
    }
    button[aria-pressed="true"] {
      border-color: #334155;
      background: #1f2937;
      color: #ffffff;
    }
    .graph-wrap {
      position: relative;
      min-height: 620px;
      overflow: hidden;
      background:
        linear-gradient(#e7ecf2 1px, transparent 1px),
        linear-gradient(90deg, #e7ecf2 1px, transparent 1px),
        #f8fafc;
      background-size: 44px 44px;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 620px;
    }
    .edge {
      stroke: #64748b;
      stroke-width: 1.4;
      opacity: 0.42;
      pointer-events: none;
    }
    .node {
      cursor: pointer;
    }
    .node circle {
      stroke: #ffffff;
      stroke-width: 2.2;
      filter: drop-shadow(0 4px 8px rgba(15, 23, 42, 0.18));
    }
    .node text {
      pointer-events: none;
      font-size: 11px;
      font-weight: 700;
      fill: #172033;
      paint-order: stroke;
      stroke: #f8fafc;
      stroke-width: 4px;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .node.selected circle {
      stroke: #111827;
      stroke-width: 3;
    }
    aside {
      border-left: 1px solid var(--line);
      background: var(--panel);
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .side-head {
      padding: 18px 18px 12px;
      border-bottom: 1px solid var(--line);
    }
    .side-head h2 {
      margin: 0 0 8px;
      font-size: 16px;
      line-height: 1.25;
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }
    .side-head p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .details {
      overflow: auto;
      padding: 14px 18px 24px;
    }
    .field {
      margin: 0 0 14px;
    }
    .field strong {
      display: block;
      margin-bottom: 4px;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--muted);
      letter-spacing: 0;
    }
    .field span, .field code, .field li {
      font-size: 12px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .field code {
      display: inline-block;
      padding: 2px 5px;
      border-radius: 5px;
      background: #f1f5f9;
      color: #0f172a;
    }
    ul {
      margin: 0;
      padding-left: 18px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px 22px;
      border-top: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.86);
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--muted);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 7px;
      background: #ffffff;
    }
    .swatch {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--swatch);
    }
    @media (max-width: 960px) {
      .shell {
        grid-template-columns: 1fr;
      }
      aside {
        border-left: 0;
        border-top: 1px solid var(--line);
        min-height: 360px;
      }
      .toolbar {
        align-items: stretch;
      }
      select, input[type="range"] {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <main>
      <header>
        <h1>OpenClaw Card Graph</h1>
        <div class="stats" id="stats"></div>
      </header>
      <section class="toolbar" aria-label="Graph controls">
        <select id="viewpoint"></select>
        <label>Rotate X <input id="rotX" type="range" min="-60" max="60" value="26"></label>
        <label>Rotate Y <input id="rotY" type="range" min="-70" max="70" value="-28"></label>
        <label>Depth <input id="depth" type="range" min="120" max="520" value="330"></label>
        <button id="toggleLabels" type="button" aria-pressed="true">Labels</button>
      </section>
      <section class="graph-wrap">
        <svg id="graph" role="img" aria-label="OpenClaw card graph"></svg>
        <div class="legend" id="legend"></div>
      </section>
    </main>
    <aside>
      <div class="side-head">
        <h2 id="detailTitle">Select a node</h2>
        <p id="detailMeta">Read-only graph. Nodes cannot execute tasks.</p>
      </div>
      <div class="details" id="details"></div>
    </aside>
  </div>
  <script id="graph-data" type="application/json">${data.replaceAll("<", "\\u003c")}</script>
  <script>
    const graph = JSON.parse(document.getElementById("graph-data").textContent);
    const svg = document.getElementById("graph");
    const stats = document.getElementById("stats");
    const legend = document.getElementById("legend");
    const details = document.getElementById("details");
    const detailTitle = document.getElementById("detailTitle");
    const detailMeta = document.getElementById("detailMeta");
    const viewpointSelect = document.getElementById("viewpoint");
    const rotX = document.getElementById("rotX");
    const rotY = document.getElementById("rotY");
    const depth = document.getElementById("depth");
    const toggleLabels = document.getElementById("toggleLabels");
    const colors = {
      source: "#2563eb",
      component: "#7c3aed",
      capability: "#059669",
      module: "#d97706",
      contract: "#dc2626",
      validation: "#0891b2",
      report: "#4b5563",
    };
    let selectedId = graph.viewpoints.find((view) => view.id === "3d-viewpoint-node-model")?.nodeIds?.[0]
      ?? graph.graph.nodes[0]?.id;

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function list(items) {
      if (!items?.length) return "<span>none</span>";
      return "<ul>" + items.map((item) => "<li><code>" + escapeHtml(item) + "</code></li>").join("") + "</ul>";
    }

    function project(point, bounds, width, height) {
      const rx = Number(rotX.value) * Math.PI / 180;
      const ry = Number(rotY.value) * Math.PI / 180;
      const cx = point.x - bounds.cx;
      const cy = point.y - bounds.cy;
      const cz = point.z - bounds.cz;
      const y1 = cy * Math.cos(rx) - cz * Math.sin(rx);
      const z1 = cy * Math.sin(rx) + cz * Math.cos(rx);
      const x2 = cx * Math.cos(ry) + z1 * Math.sin(ry);
      const z2 = -cx * Math.sin(ry) + z1 * Math.cos(ry);
      const perspective = Number(depth.value);
      const scale = perspective / (perspective + z2 + 720);
      return {
        x: width / 2 + x2 * 0.72 * scale,
        y: height / 2 + y1 * 0.72 * scale,
        z: z2,
        scale,
      };
    }

    function currentView() {
      return graph.viewpoints.find((view) => view.id === viewpointSelect.value) ?? graph.viewpoints[0];
    }

    function selectedNodes() {
      const ids = new Set(currentView().nodeIds);
      return graph.graph.nodes.filter((node) => ids.has(node.id));
    }

    function selectedLinks(nodeIds) {
      const ids = new Set(nodeIds);
      return graph.graph.links.filter((link) => ids.has(link.source) && ids.has(link.target) && link.validTarget);
    }

    function renderStats() {
      stats.innerHTML = [
        "nodes=" + graph.graph.nodes.length,
        "links=" + graph.graph.links.length,
        "missing=" + graph.graph.missingLinks.length,
        "duplicates=" + graph.graph.duplicateNodeIds.length,
        "validation=" + (graph.validation.ok ? "PASS" : "FAIL"),
        "readOnly=true",
      ].map((text) => "<span class='pill'>" + text + "</span>").join("");
    }

    function renderLegend() {
      legend.innerHTML = Object.entries(colors)
        .map(([type, color]) => "<span><i class='swatch' style='--swatch:" + color + "'></i>" + type + "</span>")
        .join("");
    }

    function renderDetails() {
      const node = graph.graph.nodes.find((entry) => entry.id === selectedId) ?? graph.graph.nodes[0];
      if (!node) return;
      detailTitle.textContent = node.label ?? node.id;
      detailMeta.textContent = node.id + " | " + node.type + " / " + node.openclawTarget + " | read-only";
      details.innerHTML = [
        ["Role", node.componentRole ?? "none"],
        ["Contract", node.contract ?? ""],
        ["Human check", node.humanReadableCheck ?? ""],
      ].map(([label, value]) => "<p class='field'><strong>" + label + "</strong><span>" + escapeHtml(value) + "</span></p>").join("")
        + "<div class='field'><strong>Links To</strong>" + list(node.linksTo) + "</div>"
        + "<div class='field'><strong>Linked By</strong>" + list(node.linkedBy) + "</div>"
        + "<div class='field'><strong>Validation</strong>" + list(node.validation) + "</div>"
        + "<div class='field'><strong>Sources</strong>" + list(node.sourceUrls) + "</div>"
        + "<div class='field'><strong>Paths</strong>" + list(node.componentPaths) + "</div>";
    }

    function renderGraph() {
      const width = Math.max(svg.clientWidth, 760);
      const height = Math.max(svg.clientHeight, 620);
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      const nodes = selectedNodes();
      const nodeIds = nodes.map((node) => node.id);
      const links = selectedLinks(nodeIds);
      const xs = nodes.map((node) => node.position.x);
      const ys = nodes.map((node) => node.position.y);
      const zs = nodes.map((node) => node.position.z);
      const bounds = {
        cx: (Math.min(...xs) + Math.max(...xs)) / 2,
        cy: (Math.min(...ys) + Math.max(...ys)) / 2,
        cz: (Math.min(...zs) + Math.max(...zs)) / 2,
      };
      const projected = new Map(nodes.map((node) => [node.id, project(node.position, bounds, width, height)]));
      const edgeMarkup = links.map((link) => {
        const a = projected.get(link.source);
        const b = projected.get(link.target);
        if (!a || !b) return "";
        return "<line class='edge' x1='" + a.x + "' y1='" + a.y + "' x2='" + b.x + "' y2='" + b.y + "' />";
      }).join("");
      const showLabels = toggleLabels.getAttribute("aria-pressed") === "true";
      const nodeMarkup = nodes
        .slice()
        .sort((a, b) => projected.get(a.id).z - projected.get(b.id).z)
        .map((node) => {
          const p = projected.get(node.id);
          const radius = Math.max(8, Math.min(19, (node.forceGraph?.nodeVal ?? 5) * 2.2 * p.scale));
          const color = colors[node.type] ?? "#334155";
          const label = escapeHtml(node.label ?? node.id);
          return "<g class='node " + (node.id === selectedId ? "selected" : "") + "' data-id='" + escapeHtml(node.id) + "' transform='translate(" + p.x + " " + p.y + ")'>"
            + "<circle r='" + radius + "' fill='" + color + "' />"
            + (showLabels ? "<text x='" + (radius + 6) + "' y='4'>" + label + "</text>" : "")
            + "</g>";
        }).join("");
      svg.innerHTML = edgeMarkup + nodeMarkup;
      svg.querySelectorAll(".node").forEach((nodeEl) => {
        nodeEl.addEventListener("click", () => {
          selectedId = nodeEl.getAttribute("data-id");
          renderDetails();
          renderGraph();
        });
      });
      if (!nodeIds.includes(selectedId)) {
        selectedId = nodeIds[0];
        renderDetails();
      }
    }

    for (const view of graph.viewpoints) {
      const option = document.createElement("option");
      option.value = view.id;
      option.textContent = view.title + " (" + view.nodeIds.length + ")";
      viewpointSelect.append(option);
    }
    viewpointSelect.value = graph.viewpoints.find((view) => view.id === "3d-viewpoint-node-model")?.id
      ?? graph.viewpoints[0]?.id;
    [viewpointSelect, rotX, rotY, depth].forEach((control) => control.addEventListener("input", renderGraph));
    toggleLabels.addEventListener("click", () => {
      const pressed = toggleLabels.getAttribute("aria-pressed") === "true";
      toggleLabels.setAttribute("aria-pressed", String(!pressed));
      renderGraph();
    });
    window.addEventListener("resize", renderGraph);
    renderStats();
    renderLegend();
    renderDetails();
    renderGraph();
  </script>
</body>
</html>
`;
}

export async function runCardFrameworkViewerRender({
  argv = process.argv.slice(2),
  repoRoot = process.cwd(),
  io = { stdout: process.stdout, stderr: process.stderr },
} = {}) {
  const normalizedRoot = path.resolve(repoRoot);
  const graphPath = toRepoPath(parseFlagValue(argv, "--graph", DEFAULT_GRAPH_PATH));
  const outPath = toRepoPath(parseFlagValue(argv, "--out", DEFAULT_OUT_PATH));
  const checkMode = argv.includes("--check");
  const graph = JSON.parse(await fs.readFile(path.join(normalizedRoot, graphPath), "utf8"));
  const failures = validateGraph(graph);
  if (failures.length > 0) {
    io.stderr.write(`openclaw card viewer blocked: ${failures.join("; ")}\n`);
    return 1;
  }
  const html = buildCardFrameworkViewerHtml(graph);
  const absoluteOutPath = path.join(normalizedRoot, outPath);

  if (checkMode) {
    let currentText;
    try {
      currentText = await fs.readFile(absoluteOutPath, "utf8");
    } catch {
      io.stderr.write(`openclaw card viewer check failed: missing ${outPath}\n`);
      return 1;
    }
    if (currentText !== html) {
      io.stderr.write(`openclaw card viewer check failed: stale ${outPath}\n`);
      return 1;
    }
    io.stdout.write(`openclaw card viewer check passed: ${outPath}\n`);
    return 0;
  }

  await fs.mkdir(path.dirname(absoluteOutPath), { recursive: true });
  await fs.writeFile(absoluteOutPath, html, "utf8");
  io.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outPath,
        nodes: graph.graph.nodes.length,
        links: graph.graph.links.length,
        viewpoints: graph.viewpoints.length,
        readOnly: true,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (invokedPath === currentPath) {
  runCardFrameworkViewerRender()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `openclaw card viewer render crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
