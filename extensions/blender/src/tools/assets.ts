import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readStringParam,
  stringEnum,
  optionalStringEnum,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { runBlenderBackground, buildBackgroundExportScript } from "../background.js";
import { createBlenderClient, resolveBlenderConfig } from "../client.js";

const IMPORT_FORMATS = [
  "FBX",
  "GLTF",
  "GLB",
  "OBJ",
  "USD",
  "USDC",
  "USDA",
  "ABC",
  "STL",
  "PLY",
  "SVG",
] as const;
const EXPORT_FORMATS = [
  "FBX",
  "GLTF",
  "GLB",
  "OBJ",
  "USD",
  "USDC",
  "USDA",
  "ABC",
  "STL",
  "PLY",
] as const;
const ASSET_TYPES = ["Object", "Material", "Mesh", "Collection", "NodeTree", "Action"] as const;

const ImportAssetSchema = Type.Object({
  filePath: Type.String({ description: "Absolute path to the asset file to import." }),
  format: stringEnum(IMPORT_FORMATS, { description: "File format of the asset." }),
  collection: Type.Optional(
    Type.String({ description: "Destination collection. Creates it if it doesn't exist." }),
  ),
  scaleFactor: Type.Optional(
    Type.Number({
      description:
        "Uniform scale factor applied on import (default: 1.0). Use 0.01 when importing cm-scaled FBX.",
      minimum: 0.0001,
    }),
  ),
});

const ExportAssetSchema = Type.Object({
  filePath: Type.String({ description: "Absolute path where the exported file will be written." }),
  format: stringEnum(EXPORT_FORMATS, { description: "Export format." }),
  mode: optionalStringEnum(["live", "background"] as const, {
    description:
      "'live' exports from the open Blender session (default). 'background' uses a headless process.",
  }),
  blendFile: Type.Optional(
    Type.String({ description: "Path to a .blend file (required in background mode)." }),
  ),
  selectionOnly: Type.Optional(
    Type.Boolean({
      description: "Export only selected objects (default: false — exports everything).",
    }),
  ),
  applyModifiers: Type.Optional(
    Type.Boolean({
      description:
        "Apply modifiers before exporting (default: true). Recommended for game engines.",
    }),
  ),
  exportAnimations: Type.Optional(
    Type.Boolean({ description: "Include animations / skeletal data in export (default: false)." }),
  ),
});

const LibraryAssetSchema = Type.Object({
  action: stringEnum(["list", "append", "link"] as const, {
    description:
      "'list' shows assets in a .blend library. 'append' copies assets into the current file. " +
      "'link' creates a live link to assets in the library.",
  }),
  libraryPath: Type.String({ description: "Path to the .blend file used as an asset library." }),
  assetType: optionalStringEnum(ASSET_TYPES, {
    description: "Type of asset to list/append/link (required for append/link).",
  }),
  assetName: Type.Optional(
    Type.String({
      description: "Name of the specific asset to append/link (required for append/link).",
    }),
  ),
});

function getClient(api: OpenClawPluginApi) {
  const cfg = resolveBlenderConfig(api.pluginConfig);
  return { client: createBlenderClient({ host: cfg.host, port: cfg.port }), cfg };
}

function buildImportCode(params: {
  filePath: string;
  format: string;
  collection?: string | null;
  scaleFactor?: number;
}): string {
  const { filePath, format, collection, scaleFactor } = params;
  const lines: string[] = ["import bpy"];
  const scale = scaleFactor ?? 1.0;

  switch (format.toUpperCase()) {
    case "FBX":
      lines.push(
        `bpy.ops.import_scene.fbx(filepath=${JSON.stringify(filePath)}, global_scale=${scale})`,
      );
      break;
    case "GLTF":
    case "GLB":
      lines.push(`bpy.ops.import_scene.gltf(filepath=${JSON.stringify(filePath)})`);
      break;
    case "OBJ":
      lines.push(
        `bpy.ops.wm.obj_import(filepath=${JSON.stringify(filePath)}, global_scale=${scale})`,
      );
      break;
    case "USD":
    case "USDC":
    case "USDA":
      lines.push(`bpy.ops.wm.usd_import(filepath=${JSON.stringify(filePath)})`);
      break;
    case "ABC":
      lines.push(`bpy.ops.wm.alembic_import(filepath=${JSON.stringify(filePath)})`);
      break;
    case "STL":
      lines.push(`bpy.ops.wm.stl_import(filepath=${JSON.stringify(filePath)})`);
      break;
    case "PLY":
      lines.push(`bpy.ops.wm.ply_import(filepath=${JSON.stringify(filePath)})`);
      break;
    default:
      throw new Error(`Unsupported import format: ${format}`);
  }

  if (collection) {
    lines.push(
      `col = bpy.data.collections.get(${JSON.stringify(collection)})`,
      `if not col:`,
      `    col = bpy.data.collections.new(${JSON.stringify(collection)})`,
      `    bpy.context.scene.collection.children.link(col)`,
      `for obj in bpy.context.selected_objects:`,
      `    for c in obj.users_collection: c.objects.unlink(obj)`,
      `    col.objects.link(obj)`,
    );
  }

  return lines.join("\n");
}

export function createImportAssetTool(api: OpenClawPluginApi) {
  return {
    name: "blender_import",
    label: "Blender: Import Asset",
    description:
      "Import an asset file (FBX, GLTF/GLB, OBJ, USD, Alembic, STL, PLY) into the current Blender scene. " +
      "Optionally place imported objects into a named collection. " +
      "FBX is the most common format from game-engine pipelines (Unreal, Unity).",
    parameters: ImportAssetSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const filePath = readStringParam(rawParams, "filePath", { required: true })!;
      const format = readStringParam(rawParams, "format", { required: true })!;
      const collection = readStringParam(rawParams, "collection");
      const scaleFactor = rawParams["scaleFactor"] as number | undefined;
      const { client } = getClient(api);

      const status = await client.status();
      if (!status.running) {
        return jsonResult("Blender bridge is not running. Import requires a live Blender session.");
      }

      const code = buildImportCode({
        filePath,
        format,
        collection: collection ?? null,
        scaleFactor,
      });
      const result = await client.execute(code);
      if (!result.ok) return jsonResult(`Import failed: ${result.error}`);

      return jsonResult(
        `Imported ${format} from: ${filePath}` +
          (collection ? ` -> collection '${collection}'` : ""),
      );
    },
  };
}

export function createExportAssetTool(api: OpenClawPluginApi) {
  return {
    name: "blender_export",
    label: "Blender: Export Asset",
    description:
      "Export the Blender scene or selection to a game-engine-ready format: FBX (Unreal/Unity), " +
      "GLTF/GLB (Godot/web), OBJ (general), USD (DCC pipeline), or Alembic (VFX/animation). " +
      "Supports live session export and headless background export from a .blend file.",
    parameters: ExportAssetSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const filePath = readStringParam(rawParams, "filePath", { required: true })!;
      const format = readStringParam(rawParams, "format", { required: true })!;
      const mode = (readStringParam(rawParams, "mode") ?? "live") as "live" | "background";
      const blendFile = readStringParam(rawParams, "blendFile");
      const selectionOnly = (rawParams["selectionOnly"] as boolean | undefined) ?? false;
      const applyModifiers = (rawParams["applyModifiers"] as boolean | undefined) ?? true;
      const exportAnimations = (rawParams["exportAnimations"] as boolean | undefined) ?? false;
      const { client, cfg } = getClient(api);

      if (mode === "background") {
        const pythonCode = buildBackgroundExportScript({
          outputPath: filePath,
          format,
          selectionOnly,
          applyModifiers,
          exportAnimations,
        });
        const result = await runBlenderBackground({
          blenderExecutable: cfg.executablePath,
          blendFile: blendFile ?? undefined,
          pythonCode,
        });
        if (!result.ok)
          return jsonResult(`Export failed:\n${result.stderr || result.stdout}`.trim());
        return jsonResult(`Exported ${format} -> ${filePath}`);
      }

      const status = await client.status();
      if (!status.running) {
        return jsonResult(
          "Blender bridge is not running. Enable the OpenClaw Bridge addon or use mode='background'.",
        );
      }

      const result = await client.exportAsset({
        filePath,
        format,
        selectionOnly,
        applyModifiers,
        exportAnimations,
      });
      if (!result.ok) return jsonResult(`Export failed: ${result.error}`);
      return jsonResult(`Exported ${format} -> ${filePath}`);
    },
  };
}

export function createLibraryAssetTool(api: OpenClawPluginApi) {
  return {
    name: "blender_library_assets",
    label: "Blender: Library Assets",
    description:
      "List, append, or link assets from a Blender asset library (.blend file). " +
      "Use 'append' to copy assets into your scene (self-contained). " +
      "Use 'link' to reference them from the library (updates propagate). " +
      "Great for shared material libraries, prop kits, and character rigs in game projects.",
    parameters: LibraryAssetSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readStringParam(rawParams, "action", { required: true })!;
      const libraryPath = readStringParam(rawParams, "libraryPath", { required: true })!;
      const assetType = readStringParam(rawParams, "assetType");
      const assetName = readStringParam(rawParams, "assetName");
      const { client } = getClient(api);

      const status = await client.status();
      if (!status.running) {
        return jsonResult(
          "Blender bridge is not running. Library operations require a live Blender session.",
        );
      }

      let code: string;

      if (action === "list") {
        code = [
          "import bpy",
          `with bpy.data.libraries.load(${JSON.stringify(libraryPath)}, link=False) as (data_from, _):`,
          `    result = {`,
          `        'objects': list(data_from.objects),`,
          `        'materials': list(data_from.materials),`,
          `        'collections': list(data_from.collections),`,
          `        'meshes': list(data_from.meshes),`,
          `        'node_groups': list(data_from.node_groups),`,
          `        'actions': list(data_from.actions),`,
          `    }`,
          `print(result)`,
        ].join("\n");
      } else if (action === "append" || action === "link") {
        if (!assetType || !assetName) {
          return jsonResult("assetType and assetName are required for append/link actions.");
        }
        const isLink = action === "link";
        const typeMap: Record<string, string> = {
          Object: "objects",
          Material: "materials",
          Mesh: "meshes",
          Collection: "collections",
          NodeTree: "node_groups",
          Action: "actions",
        };
        const attr = typeMap[assetType] ?? "objects";
        code = [
          "import bpy",
          `with bpy.data.libraries.load(${JSON.stringify(libraryPath)}, link=${isLink ? "True" : "False"}) as (data_from, data_to):`,
          `    if ${JSON.stringify(assetName)} in data_from.${attr}:`,
          `        data_to.${attr} = [${JSON.stringify(assetName)}]`,
          `    else:`,
          `        raise ValueError(f"Asset '${assetName}' not found in library")`,
          ...(assetType === "Object" && !isLink
            ? [
                `for obj in data_to.objects:`,
                `    if obj is not None:`,
                `        bpy.context.collection.objects.link(obj)`,
              ]
            : []),
        ].join("\n");
      } else {
        return jsonResult(`Unknown action: ${action}`);
      }

      const result = await client.execute(code);
      if (!result.ok) return jsonResult(`Library operation failed: ${result.error}`);

      if (action === "list") {
        return jsonResult(`Library assets in ${libraryPath}:\n${result.output ?? "(none)"}`);
      }
      return jsonResult(
        `${action === "append" ? "Appended" : "Linked"} ${assetType} '${assetName}' from library.`,
      );
    },
  };
}
