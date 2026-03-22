import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import {
  createImportAssetTool,
  createExportAssetTool,
  createLibraryAssetTool,
} from "./src/tools/assets.js";
import {
  createGenerateLodTool,
  createCollisionMeshTool,
  createUvUnwrapTool,
  createGameExportTool,
  createCheckGameReadinessTool,
} from "./src/tools/game.js";
import {
  createApplyMaterialTool,
  createBakeTexturesTool,
  createAssignTextureTool,
} from "./src/tools/materials.js";
import { createExecutePythonTool } from "./src/tools/python.js";
import {
  createRenderTool,
  createBatchRenderTool,
  createScreenshotTool,
} from "./src/tools/render.js";
import {
  createGetSceneInfoTool,
  createCreateObjectTool,
  createManageCollectionTool,
  createSetRenderSettingsTool,
} from "./src/tools/scene.js";

export default definePluginEntry({
  id: "blender",
  name: "Blender Plugin",
  description:
    "Deep Blender integration for technical artists building games. " +
    "Control Blender via the Python API, manage rendering pipelines, import/export game assets, " +
    "bake textures, generate LODs, create collision meshes, and export to Unreal, Unity, and Godot.",

  register(api) {
    // Python scripting
    api.registerTool(createExecutePythonTool(api) as AnyAgentTool);

    // Scene management
    api.registerTool(createGetSceneInfoTool(api) as AnyAgentTool);
    api.registerTool(createCreateObjectTool(api) as AnyAgentTool);
    api.registerTool(createManageCollectionTool(api) as AnyAgentTool);
    api.registerTool(createSetRenderSettingsTool(api) as AnyAgentTool);

    // Rendering
    api.registerTool(createRenderTool(api) as AnyAgentTool);
    api.registerTool(createBatchRenderTool(api) as AnyAgentTool);
    api.registerTool(createScreenshotTool(api) as AnyAgentTool);

    // Asset management
    api.registerTool(createImportAssetTool(api) as AnyAgentTool);
    api.registerTool(createExportAssetTool(api) as AnyAgentTool);
    api.registerTool(createLibraryAssetTool(api) as AnyAgentTool);

    // Materials & textures
    api.registerTool(createApplyMaterialTool(api) as AnyAgentTool);
    api.registerTool(createBakeTexturesTool(api) as AnyAgentTool);
    api.registerTool(createAssignTextureTool(api) as AnyAgentTool);

    // Game-specific tools
    api.registerTool(createGenerateLodTool(api) as AnyAgentTool);
    api.registerTool(createCollisionMeshTool(api) as AnyAgentTool);
    api.registerTool(createUvUnwrapTool(api) as AnyAgentTool);
    api.registerTool(createGameExportTool(api) as AnyAgentTool);
    api.registerTool(createCheckGameReadinessTool(api) as AnyAgentTool);
  },
});
