#!/usr/bin/env node
/**
 * PenPot MCP Server
 *
 * A stdio MCP server that exposes PenPot design tools via the Model Context Protocol.
 * Talks directly to PenPot's backend RPC API using Transit-encoded HTTP.
 *
 * Environment variables:
 *   PENPOT_ACCESS_TOKEN - Required. Access token from PenPot Settings.
 *   PENPOT_BASE_URL     - Optional. Default: https://design.penpot.app
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import transit from "transit-js";
import { z } from "zod";

// ============================================================================
// Transit encode/decode
// ============================================================================

function kw(name) {
  return transit.keyword(name);
}

function prepareForTransit(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value)) return value.map(prepareForTransit);
  if (value instanceof Date) return value;
  if (transit.isKeyword(value) || transit.isUUID(value)) return value;
  if (typeof value === "object") {
    const entries = [];
    for (const [k, v] of Object.entries(value)) {
      entries.push(kw(k));
      entries.push(prepareForTransit(v));
    }
    return transit.map(entries);
  }
  return value;
}

function transitEncode(value) {
  const w = transit.writer("json");
  return w.write(prepareForTransit(value));
}

function transitToJs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (transit.isKeyword(value)) return value._name;
  if (transit.isUUID(value)) return String(value);
  if (Array.isArray(value)) return value.map(transitToJs);
  // Handle transit-js tagged values (custom types like "shape", "matrix")
  if (value && typeof value === "object" && "tag" in value && "rep" in value) {
    return transitToJs(value.rep);
  }
  if (
    value &&
    typeof value === "object" &&
    "forEach" in value &&
    typeof value.forEach === "function"
  ) {
    const result = {};
    value.forEach((v, k) => {
      const key = transit.isKeyword(k) ? k._name : String(k);
      result[key] = transitToJs(v);
    });
    return result;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function transitDecode(data) {
  const r = transit.reader("json", {
    handlers: { u: (rep) => String(rep) },
    defaultHandler: (_tag, rep) => rep,
  });
  return transitToJs(r.read(data));
}

// ============================================================================
// PenPot Client
// ============================================================================

const BASE_URL = (process.env.PENPOT_BASE_URL || "https://design.penpot.app").replace(/\/+$/, "");
const ACCESS_TOKEN = process.env.PENPOT_ACCESS_TOKEN;

async function rpc(command, params = {}) {
  const url = `${BASE_URL}/api/rpc/command/${command}`;
  const body = transitEncode(params);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/transit+json",
      Accept: "application/transit+json",
      Authorization: `Token ${ACCESS_TOKEN}`,
    },
    body,
  });

  if (!response.ok) {
    const ct = response.headers.get("content-type") || "";
    const errBody = ct.includes("transit")
      ? transitDecode(await response.text())
      : await response.text();
    throw new Error(
      `PenPot RPC ${command} failed (${response.status}): ${JSON.stringify(errBody)}`,
    );
  }

  const ct = response.headers.get("content-type") || "";
  if (ct.includes("transit")) return transitDecode(await response.text());
  if (response.status === 204) return null;
  return response.json();
}

// ============================================================================
// Geometry helpers
// ============================================================================

function computeSelrect(x, y, w, h) {
  return { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h };
}

function computePoints(x, y, w, h) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const ROOT_FRAME = "00000000-0000-0000-0000-000000000000";

// ============================================================================
// Changes Builder
// ============================================================================

class ChangesBuilder {
  constructor(pageId) {
    this.pageId = pageId;
    this.changes = [];
  }

  addPage(id, name) {
    id = id || crypto.randomUUID();
    this.changes.push({ type: "add-page", id, name: name || "Page" });
    return id;
  }

  _buildObj(input, type, extra = {}) {
    const { x, y, width, height } = input;
    return {
      id: input.id || crypto.randomUUID(),
      name: input.name,
      type,
      x,
      y,
      width,
      height,
      rotation: input.rotation ?? 0,
      selrect: computeSelrect(x, y, width, height),
      points: computePoints(x, y, width, height),
      transform: IDENTITY,
      "transform-inverse": IDENTITY,
      "proportion-lock": false,
      ...(input.opacity !== undefined ? { opacity: input.opacity } : {}),
      ...(input.fills ? { fills: input.fills } : {}),
      ...(input.strokes ? { strokes: input.strokes } : {}),
      ...extra,
    };
  }

  _addObj(obj, parentId, frameId) {
    obj["frame-id"] = frameId;
    obj["parent-id"] = parentId;
    this.changes.push({
      type: "add-obj",
      id: obj.id,
      "page-id": this.pageId,
      "frame-id": frameId,
      "parent-id": parentId,
      obj,
    });
    return obj.id;
  }

  addShape(input, parentId = ROOT_FRAME, frameId = ROOT_FRAME) {
    const t = input.type;
    const extra = {};

    if (t === "rect") {
      for (const k of ["r1", "r2", "r3", "r4"]) if (input[k] !== undefined) extra[k] = input[k];
    }
    if (t === "text") {
      if (input.paragraphs) extra.content = this._buildTextContent(input.paragraphs);
      if (input.growType) extra["grow-type"] = input.growType;
    }
    if (t === "frame" || t === "group") {
      extra.shapes = [];
    }
    if (t === "frame") {
      if (input.fillColor)
        extra.fills = [{ "fill-color": input.fillColor, "fill-opacity": input.fillOpacity ?? 1 }];
      if (input.layout) {
        for (const [k, v] of Object.entries(input.layout)) if (v !== undefined) extra[k] = v;
      }
    }

    const obj = this._buildObj(input, t, extra);
    const id = this._addObj(obj, parentId, frameId);

    if ((t === "frame" || t === "group") && input.children) {
      const childFrame = t === "frame" ? id : frameId;
      for (const child of input.children) this.addShape(child, id, childFrame);
    }
    return id;
  }

  modShape(shapeId, attrs) {
    this.changes.push({
      type: "mod-obj",
      id: shapeId,
      "page-id": this.pageId,
      operations: Object.entries(attrs).map(([attr, val]) => ({ type: "set", attr, val })),
    });
  }

  delShape(shapeId) {
    this.changes.push({ type: "del-obj", id: shapeId, "page-id": this.pageId });
  }

  moveShapes(shapeIds, parentId, index) {
    this.changes.push({
      type: "mov-objects",
      "page-id": this.pageId,
      "parent-id": parentId,
      shapes: shapeIds,
      ...(index !== undefined ? { index } : {}),
    });
  }

  addColor(id, name, color, opacity = 1) {
    this.changes.push({ type: "add-color", color: { id, name, color, opacity } });
  }

  addTypography(id, name, fontFamily, fontSize, fontWeight = "400", opts = {}) {
    this.changes.push({
      type: "add-typography",
      typography: {
        id,
        name,
        "font-id": opts.fontId || fontFamily.toLowerCase().replace(/\s+/g, "-"),
        "font-family": fontFamily,
        "font-variant-id": opts.fontVariantId || "regular",
        "font-size": fontSize,
        "font-weight": fontWeight,
        "font-style": opts.fontStyle || "normal",
        "line-height": opts.lineHeight || "1.2",
        "letter-spacing": opts.letterSpacing || "0",
        "text-transform": opts.textTransform || "none",
      },
    });
  }

  _buildTextContent(paragraphs) {
    return {
      type: "root",
      children: [
        {
          type: "paragraph-set",
          children: paragraphs.map((p) => ({
            type: "paragraph",
            ...(p.textAlign ? { "text-align": p.textAlign } : {}),
            children: p.spans.map((s) => ({
              type: "text",
              text: s.text,
              ...(s.fontFamily ? { "font-family": s.fontFamily } : {}),
              ...(s.fontSize ? { "font-size": s.fontSize } : {}),
              ...(s.fontWeight ? { "font-weight": s.fontWeight } : {}),
              ...(s.fontStyle ? { "font-style": s.fontStyle } : {}),
              ...(s.fillColor ? { "fill-color": s.fillColor } : {}),
              ...(s.fillOpacity !== undefined ? { "fill-opacity": s.fillOpacity } : {}),
              ...(s.letterSpacing ? { "letter-spacing": s.letterSpacing } : {}),
              ...(s.lineHeight ? { "line-height": s.lineHeight } : {}),
            })),
          })),
        },
      ],
    };
  }
}

async function updateFile(fileId, revn, changes) {
  return rpc("update-file", {
    id: fileId,
    revn,
    vern: 0,
    "session-id": crypto.randomUUID(),
    changes,
  });
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new McpServer({
  name: "penpot",
  version: "1.0.0",
});

// -- penpot_list_projects -----------------------------------------------------
server.tool(
  "penpot_list_projects",
  "List all teams and their projects in PenPot. Use this to find team-id and project-id for creating files.",
  { teamId: z.string().optional().describe("Filter to a specific team ID") },
  async ({ teamId }) => {
    if (teamId) {
      const projects = await rpc("get-projects", { "team-id": teamId });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { teamId, projects: projects.map((p) => ({ id: p.id, name: p.name })) },
              null,
              2,
            ),
          },
        ],
      };
    }
    const teams = await rpc("get-teams");
    const results = [];
    for (const team of teams) {
      const projects = await rpc("get-projects", { "team-id": team.id });
      results.push({
        teamId: team.id,
        teamName: team.name,
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
      });
    }
    return { content: [{ type: "text", text: JSON.stringify({ teams: results }, null, 2) }] };
  },
);

// -- penpot_create_file -------------------------------------------------------
server.tool(
  "penpot_create_file",
  "Create a new design file in a PenPot project. Returns file ID, initial page ID, and revision numbers.",
  {
    projectId: z.string().describe("Project ID to create the file in"),
    name: z.string().describe("Name for the new design file"),
  },
  async ({ projectId, name }) => {
    const file = await rpc("create-file", { "project-id": projectId, name });
    const data = file.data || {};
    const pages = (data.pages || []).map((pid) => ({
      id: pid,
      name: data["pages-index"]?.[pid]?.name || "Page 1",
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { fileId: file.id, name: file.name, revn: file.revn ?? 0, pages },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// -- penpot_inspect_file ------------------------------------------------------
server.tool(
  "penpot_inspect_file",
  "Read the structure of a PenPot design file. Returns pages, shapes, and the current revision number (revn).",
  {
    fileId: z.string().describe("The file ID to inspect"),
    includeShapes: z.boolean().optional().default(true).describe("Include shape details"),
  },
  async ({ fileId, includeShapes }) => {
    const file = await rpc("get-file", { id: fileId });
    const data = file.data || {};
    const pageIds = data.pages || [];
    const pagesIndex = data["pages-index"] || {};
    const pages = pageIds.map((pid) => {
      const page = pagesIndex[pid];
      if (!page) return { id: pid, name: "Unknown" };
      const result = { id: pid, name: page.name };
      if (includeShapes) {
        const objects = page.objects || {};
        result.shapeCount = Object.keys(objects).length;
        result.shapes = Object.values(objects).map((o) => ({
          id: o.id,
          name: o.name,
          type: o.type,
          x: o.x,
          y: o.y,
          width: o.width,
          height: o.height,
        }));
      }
      return result;
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { fileId: file.id, name: file.name, revn: file.revn ?? 0, pages },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// -- penpot_add_page ----------------------------------------------------------
server.tool(
  "penpot_add_page",
  "Add a new page to an existing PenPot design file.",
  {
    fileId: z.string().describe("File ID"),
    revn: z.number().describe("Current file revision number"),
    name: z.string().optional().default("Page").describe("Page name"),
  },
  async ({ fileId, revn, name }) => {
    const pageId = crypto.randomUUID();
    const builder = new ChangesBuilder(pageId);
    builder.addPage(pageId, name);
    await updateFile(fileId, revn, builder.changes);
    return {
      content: [
        { type: "text", text: JSON.stringify({ pageId, name, newRevn: revn + 1 }, null, 2) },
      ],
    };
  },
);

// -- penpot_design_ui ---------------------------------------------------------
server.tool(
  "penpot_design_ui",
  `Design a complete UI layout in PenPot by describing a component tree. This is the primary design tool.

Each shape: type (rect/circle/text/frame/group), name, x, y, width, height.
Frames can have children and layout properties (flex/grid).
Text shapes need paragraphs with spans.
Rects can have border radius (r1-r4) and fills.

Example button:
{"type":"frame","name":"Button","x":0,"y":0,"width":200,"height":48,"fillColor":"#3B82F6",
 "layout":{"layout":"flex","layout-flex-dir":"row","layout-justify-content":"center","layout-align-items":"center"},
 "children":[{"type":"text","name":"Label","x":0,"y":0,"width":100,"height":24,
   "paragraphs":[{"spans":[{"text":"Click Me","fontSize":"16","fontWeight":"600","fillColor":"#FFFFFF"}],"textAlign":"center"}]}]}`,
  {
    fileId: z.string().describe("File ID"),
    pageId: z.string().describe("Page ID"),
    revn: z.number().describe("Current file revision number"),
    shapes: z.array(z.any()).describe("Array of shape trees"),
  },
  async ({ fileId, pageId, revn, shapes }) => {
    const builder = new ChangesBuilder(pageId);
    const ids = shapes.map((s) => builder.addShape(s));
    await updateFile(fileId, revn, builder.changes);
    const created = builder.changes.filter((c) => c.type === "add-obj").length;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: true, shapesCreated: created, rootShapeIds: ids, newRevn: revn + 1 },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// -- penpot_update_file -------------------------------------------------------
server.tool(
  "penpot_update_file",
  `Low-level file update for individual shape operations.
Operations: add-shape, modify-shape, delete-shape, move-shapes.`,
  {
    fileId: z.string().describe("File ID"),
    pageId: z.string().describe("Page ID"),
    revn: z.number().describe("Current file revision number"),
    operations: z
      .array(
        z.object({
          op: z.enum(["add-shape", "modify-shape", "delete-shape", "move-shapes"]),
          shape: z.any().optional(),
          parentId: z.string().optional(),
          frameId: z.string().optional(),
          shapeId: z.string().optional(),
          attrs: z.record(z.any()).optional(),
          shapeIds: z.array(z.string()).optional(),
          index: z.number().optional(),
        }),
      )
      .describe("Array of operations"),
  },
  async ({ fileId, pageId, revn, operations }) => {
    const builder = new ChangesBuilder(pageId);
    const results = [];
    for (const op of operations) {
      switch (op.op) {
        case "add-shape":
          results.push({
            op: "add-shape",
            id: builder.addShape(op.shape, op.parentId, op.frameId),
          });
          break;
        case "modify-shape":
          builder.modShape(op.shapeId, op.attrs);
          results.push({ op: "modify-shape", id: op.shapeId });
          break;
        case "delete-shape":
          builder.delShape(op.shapeId);
          results.push({ op: "delete-shape", id: op.shapeId });
          break;
        case "move-shapes":
          builder.moveShapes(op.shapeIds, op.parentId, op.index);
          results.push({ op: "move-shapes" });
          break;
      }
    }
    await updateFile(fileId, revn, builder.changes);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, results, newRevn: revn + 1 }, null, 2),
        },
      ],
    };
  },
);

// -- penpot_manage_library ----------------------------------------------------
server.tool(
  "penpot_manage_library",
  "Add colors and typography styles to a PenPot file's library for consistent styling.",
  {
    fileId: z.string().describe("File ID"),
    revn: z.number().describe("Current file revision number"),
    colors: z
      .array(
        z.object({
          name: z.string(),
          color: z.string(),
          opacity: z.number().optional().default(1),
        }),
      )
      .optional()
      .describe("Colors to add"),
    typographies: z
      .array(
        z.object({
          name: z.string(),
          fontFamily: z.string(),
          fontSize: z.string(),
          fontWeight: z.string().optional().default("400"),
          fontStyle: z.string().optional(),
          lineHeight: z.string().optional(),
          letterSpacing: z.string().optional(),
        }),
      )
      .optional()
      .describe("Typography styles to add"),
  },
  async ({ fileId, revn, colors, typographies }) => {
    const builder = new ChangesBuilder(ROOT_FRAME);
    const colorIds = [];
    const typoIds = [];
    if (colors)
      for (const c of colors) {
        const id = crypto.randomUUID();
        builder.addColor(id, c.name, c.color, c.opacity);
        colorIds.push({ id, name: c.name });
      }
    if (typographies)
      for (const t of typographies) {
        const id = crypto.randomUUID();
        builder.addTypography(id, t.name, t.fontFamily, t.fontSize, t.fontWeight, {
          fontStyle: t.fontStyle,
          lineHeight: t.lineHeight,
          letterSpacing: t.letterSpacing,
        });
        typoIds.push({ id, name: t.name });
      }
    if (builder.changes.length === 0)
      return { content: [{ type: "text", text: "No library items to add." }] };
    await updateFile(fileId, revn, builder.changes);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { success: true, colorsAdded: colorIds, typographiesAdded: typoIds, newRevn: revn + 1 },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ============================================================================
// Start
// ============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
