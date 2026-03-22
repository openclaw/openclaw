import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildBackgroundRenderScript, buildBackgroundExportScript } from "./background.js";
import { createBlenderClient, resolveBlenderConfig } from "./client.js";
import { createImportAssetTool, createExportAssetTool } from "./tools/assets.js";
import {
  createGenerateLodTool,
  createCollisionMeshTool,
  createUvUnwrapTool,
  createGameExportTool,
  createCheckGameReadinessTool,
} from "./tools/game.js";
import { createApplyMaterialTool, createBakeTexturesTool } from "./tools/materials.js";
import { createExecutePythonTool } from "./tools/python.js";
import { createRenderTool, createBatchRenderTool } from "./tools/render.js";
import { createGetSceneInfoTool, createCreateObjectTool } from "./tools/scene.js";

// Minimal mock of the plugin API
function makeApi(pluginConfig?: Record<string, unknown>): OpenClawPluginApi {
  return {
    pluginConfig,
    config: {} as never,
    id: "blender",
    name: "Blender Plugin",
    source: "test",
    registrationMode: "full",
    runtime: {} as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    registerTool: vi.fn(),
    registerChannel: vi.fn(),
    registerProvider: vi.fn(),
    registerSpeechProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerImageGenerationProvider: vi.fn(),
    registerWebSearchProvider: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerService: vi.fn(),
    registerCli: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    registerMemoryPromptSection: vi.fn(),
    on: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    resolvePath: (p: string) => p,
  } as never;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

describe("resolveBlenderConfig", () => {
  it("returns defaults when no config provided", () => {
    const cfg = resolveBlenderConfig(undefined);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(7428);
    expect(typeof cfg.executablePath).toBe("string");
    expect(cfg.executablePath.length).toBeGreaterThan(0);
  });

  it("respects overrides from pluginConfig", () => {
    const cfg = resolveBlenderConfig({
      blender: { bridgeHost: "192.168.1.5", bridgePort: 9999, executablePath: "/usr/bin/blender" },
    });
    expect(cfg.host).toBe("192.168.1.5");
    expect(cfg.port).toBe(9999);
    expect(cfg.executablePath).toBe("/usr/bin/blender");
  });
});

// ---------------------------------------------------------------------------
// Tool registration — every tool must have name, description, parameters, execute
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  const api = makeApi();

  const tools = [
    createExecutePythonTool(api),
    createGetSceneInfoTool(api),
    createCreateObjectTool(api),
    createRenderTool(api),
    createBatchRenderTool(api),
    createImportAssetTool(api),
    createExportAssetTool(api),
    createApplyMaterialTool(api),
    createBakeTexturesTool(api),
    createGenerateLodTool(api),
    createCollisionMeshTool(api),
    createUvUnwrapTool(api),
    createGameExportTool(api),
    createCheckGameReadinessTool(api),
  ];

  it("all tools have unique names", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const tool of tools) {
    it(`${tool.name} has required fields`, () => {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    });
  }
});

// ---------------------------------------------------------------------------
// Background script builders
// ---------------------------------------------------------------------------

describe("buildBackgroundRenderScript", () => {
  it("generates still render code", () => {
    const code = buildBackgroundRenderScript({ outputPath: "/tmp/out.png" });
    expect(code).toContain("import bpy");
    expect(code).toContain("/tmp/out.png");
    expect(code).toContain("write_still=True");
    expect(code).not.toContain("animation=True");
  });

  it("generates animation render code", () => {
    const code = buildBackgroundRenderScript({
      outputPath: "/tmp/frames/",
      frameStart: 1,
      frameEnd: 24,
    });
    expect(code).toContain("animation=True");
    expect(code).toContain("frame_start = 1");
    expect(code).toContain("frame_end = 24");
  });

  it("applies engine override", () => {
    const code = buildBackgroundRenderScript({ outputPath: "/tmp/out.png", engine: "CYCLES" });
    expect(code).toContain("CYCLES");
  });

  it("applies resolution overrides", () => {
    const code = buildBackgroundRenderScript({
      outputPath: "/tmp/out.png",
      resolutionX: 3840,
      resolutionY: 2160,
    });
    expect(code).toContain("resolution_x = 3840");
    expect(code).toContain("resolution_y = 2160");
  });
});

describe("buildBackgroundExportScript", () => {
  it("generates FBX export code", () => {
    const code = buildBackgroundExportScript({ outputPath: "/tmp/mesh.fbx", format: "FBX" });
    expect(code).toContain("export_scene.fbx");
    expect(code).toContain("/tmp/mesh.fbx");
  });

  it("generates GLTF export code", () => {
    const code = buildBackgroundExportScript({ outputPath: "/tmp/mesh.gltf", format: "GLTF" });
    expect(code).toContain("export_scene.gltf");
  });

  it("generates GLB export code", () => {
    const code = buildBackgroundExportScript({ outputPath: "/tmp/mesh.glb", format: "GLB" });
    expect(code).toContain("GLB");
  });

  it("generates OBJ export code", () => {
    const code = buildBackgroundExportScript({ outputPath: "/tmp/mesh.obj", format: "OBJ" });
    expect(code).toContain("wm.obj_export");
  });

  it("generates USD export code", () => {
    const code = buildBackgroundExportScript({ outputPath: "/tmp/scene.usd", format: "USD" });
    expect(code).toContain("wm.usd_export");
  });

  it("throws on unsupported format", () => {
    expect(() =>
      buildBackgroundExportScript({ outputPath: "/tmp/bad.xyz", format: "XYZ" }),
    ).toThrow("Unsupported export format");
  });

  it("respects selectionOnly flag", () => {
    const code = buildBackgroundExportScript({
      outputPath: "/tmp/mesh.fbx",
      format: "FBX",
      selectionOnly: true,
    });
    expect(code).toContain("use_selection=True");
  });
});

// ---------------------------------------------------------------------------
// Tool execution — bridge-down path (no live Blender required)
// ---------------------------------------------------------------------------

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  return item?.type === "text" ? (item.text ?? "") : "";
}

describe("tool execution when bridge is offline", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Connection refused");
    });
  });

  it("blender_execute_python returns helpful message", async () => {
    const api = makeApi();
    const tool = createExecutePythonTool(api);
    const result = await tool.execute("call1", { code: "print('hello')", mode: "live" });
    expect(firstText(result)).toContain("not running");
  });

  it("blender_get_scene_info returns helpful message", async () => {
    const api = makeApi();
    const tool = createGetSceneInfoTool(api);
    const result = await tool.execute("call2", {});
    expect(firstText(result)).toContain("not running");
  });

  it("blender_render live mode returns helpful message", async () => {
    const api = makeApi();
    const tool = createRenderTool(api);
    const result = await tool.execute("call3", { outputPath: "/tmp/out.png", mode: "live" });
    expect(firstText(result)).toContain("not running");
  });

  it("blender_import returns helpful message", async () => {
    const api = makeApi();
    const tool = createImportAssetTool(api);
    const result = await tool.execute("call4", { filePath: "/tmp/asset.fbx", format: "FBX" });
    expect(firstText(result)).toContain("not running");
  });

  it("blender_apply_material returns helpful message", async () => {
    const api = makeApi();
    const tool = createApplyMaterialTool(api);
    const result = await tool.execute("call5", {
      objectName: "Cube",
      materialName: "TestMat",
    });
    expect(firstText(result)).toContain("not running");
  });
});
