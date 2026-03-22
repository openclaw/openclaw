import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readStringParam,
  stringEnum,
  optionalStringEnum,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { createBlenderClient, resolveBlenderConfig } from "../client.js";

const GetSceneInfoSchema = Type.Object({});

const CreateObjectSchema = Type.Object({
  type: stringEnum(
    [
      "MESH_CUBE",
      "MESH_SPHERE",
      "MESH_PLANE",
      "MESH_CYLINDER",
      "MESH_CONE",
      "MESH_TORUS",
      "CAMERA",
      "LIGHT_POINT",
      "LIGHT_SUN",
      "LIGHT_SPOT",
      "LIGHT_AREA",
      "EMPTY",
      "ARMATURE",
    ] as const,
    { description: "Type of object to create." },
  ),
  name: Type.Optional(Type.String({ description: "Name for the new object." })),
  location: Type.Optional(
    Type.Tuple([Type.Number(), Type.Number(), Type.Number()], {
      description: "World-space location [x, y, z] in meters.",
    }),
  ),
  collection: Type.Optional(
    Type.String({ description: "Collection to add the object to. Creates it if missing." }),
  ),
});

const ManageCollectionSchema = Type.Object({
  action: stringEnum(["create", "delete", "hide", "show", "move_object"] as const, {
    description: "Action to perform on the collection.",
  }),
  collectionName: Type.String({ description: "Name of the collection." }),
  objectName: Type.Optional(
    Type.String({ description: "Object to move (required when action='move_object')." }),
  ),
  parentCollection: Type.Optional(
    Type.String({ description: "Parent collection for nesting (used with 'create')." }),
  ),
});

const SetRenderSettingsSchema = Type.Object({
  engine: optionalStringEnum(["CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"] as const, {
    description: "Render engine.",
  }),
  resolutionX: Type.Optional(Type.Number({ description: "Render width in pixels.", minimum: 1 })),
  resolutionY: Type.Optional(Type.Number({ description: "Render height in pixels.", minimum: 1 })),
  resolutionPercent: Type.Optional(
    Type.Number({ description: "Resolution scale percentage (1-200).", minimum: 1, maximum: 200 }),
  ),
  samples: Type.Optional(Type.Number({ description: "Render samples.", minimum: 1 })),
  fps: Type.Optional(Type.Number({ description: "Frames per second.", minimum: 1 })),
  frameStart: Type.Optional(Type.Number({ description: "Start frame." })),
  frameEnd: Type.Optional(Type.Number({ description: "End frame." })),
  outputPath: Type.Optional(
    Type.String({ description: "Output file path (supports Blender tokens like //render/)." }),
  ),
  outputFormat: optionalStringEnum(
    ["PNG", "JPEG", "EXR", "OPEN_EXR_MULTILAYER", "FFMPEG"] as const,
    { description: "Output file format." },
  ),
  useDenoising: Type.Optional(Type.Boolean({ description: "Enable denoising (Cycles only)." })),
  transparentBackground: Type.Optional(
    Type.Boolean({ description: "Render with transparent background (RGBA)." }),
  ),
});

function getClient(api: OpenClawPluginApi) {
  const cfg = resolveBlenderConfig(api.pluginConfig);
  return createBlenderClient({ host: cfg.host, port: cfg.port });
}

async function requireLiveBridge(api: OpenClawPluginApi) {
  const client = getClient(api);
  const status = await client.status();
  if (!status.running) {
    return {
      client: null,
      error: "Blender bridge is not running. Open Blender and enable the OpenClaw Bridge addon.",
    };
  }
  return { client, error: null };
}

export function createGetSceneInfoTool(api: OpenClawPluginApi) {
  return {
    name: "blender_get_scene_info",
    label: "Blender: Get Scene Info",
    description:
      "Retrieve the current Blender scene hierarchy — all objects with their types, locations, materials, " +
      "polygon counts, collections, render settings, active camera, and frame range. " +
      "Essential first step before making changes to a scene.",
    parameters: GetSceneInfoSchema,

    execute: async (_toolCallId: string, _rawParams: Record<string, unknown>) => {
      const { client, error } = await requireLiveBridge(api);
      if (!client) return jsonResult(error!);

      const scene = await client.sceneInfo();
      return jsonResult(scene);
    },
  };
}

export function createCreateObjectTool(api: OpenClawPluginApi) {
  return {
    name: "blender_create_object",
    label: "Blender: Create Object",
    description:
      "Add a new object (mesh primitive, camera, light, empty, or armature) to the current Blender scene. " +
      "Use this to scaffold scenes, set up cameras for render pipelines, or add lighting rigs.",
    parameters: CreateObjectSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { client, error } = await requireLiveBridge(api);
      if (!client) return jsonResult(error!);

      const type = readStringParam(rawParams, "type", { required: true });
      const name = readStringParam(rawParams, "name");
      const location = rawParams["location"] as [number, number, number] | undefined;
      const collection = readStringParam(rawParams, "collection");

      const lines: string[] = ["import bpy"];

      const meshTypes: Record<string, string> = {
        MESH_CUBE: "bpy.ops.mesh.primitive_cube_add",
        MESH_SPHERE: "bpy.ops.mesh.primitive_uv_sphere_add",
        MESH_PLANE: "bpy.ops.mesh.primitive_plane_add",
        MESH_CYLINDER: "bpy.ops.mesh.primitive_cylinder_add",
        MESH_CONE: "bpy.ops.mesh.primitive_cone_add",
        MESH_TORUS: "bpy.ops.mesh.primitive_torus_add",
      };
      const lightTypes: Record<string, string> = {
        LIGHT_POINT: "POINT",
        LIGHT_SUN: "SUN",
        LIGHT_SPOT: "SPOT",
        LIGHT_AREA: "AREA",
      };

      const loc = location ? `location=(${location.join(", ")})` : "location=(0,0,0)";

      if (meshTypes[type!]) {
        lines.push(`${meshTypes[type!]}(${loc})`);
      } else if (lightTypes[type!]) {
        lines.push(`bpy.ops.object.light_add(type=${JSON.stringify(lightTypes[type!])}, ${loc})`);
      } else if (type === "CAMERA") {
        lines.push(`bpy.ops.object.camera_add(${loc})`);
      } else if (type === "EMPTY") {
        lines.push(`bpy.ops.object.empty_add(${loc})`);
      } else if (type === "ARMATURE") {
        lines.push(`bpy.ops.object.armature_add(${loc})`);
      }

      lines.push(`obj = bpy.context.active_object`);
      if (name) lines.push(`obj.name = ${JSON.stringify(name)}`);

      if (collection) {
        lines.push(
          `col = bpy.data.collections.get(${JSON.stringify(collection)})`,
          `if not col:`,
          `    col = bpy.data.collections.new(${JSON.stringify(collection)})`,
          `    bpy.context.scene.collection.children.link(col)`,
          `for c in obj.users_collection: c.objects.unlink(obj)`,
          `col.objects.link(obj)`,
        );
      }

      const result = await client.execute(lines.join("\n"));
      if (!result.ok) return jsonResult(`Failed to create object: ${result.error}`);
      return jsonResult(
        `Created ${type}${name ? ` named "${name}"` : ""} at ${JSON.stringify(location ?? [0, 0, 0])}.`,
      );
    },
  };
}

export function createManageCollectionTool(api: OpenClawPluginApi) {
  return {
    name: "blender_manage_collections",
    label: "Blender: Manage Collections",
    description:
      "Create, delete, show, hide, or move objects between collections (layers) in the Blender scene. " +
      "Collections are the primary organisational unit in Blender, equivalent to layers in game engines.",
    parameters: ManageCollectionSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { client, error } = await requireLiveBridge(api);
      if (!client) return jsonResult(error!);

      const action = readStringParam(rawParams, "action", { required: true });
      const collectionName = readStringParam(rawParams, "collectionName", { required: true });
      const objectName = readStringParam(rawParams, "objectName");
      const parentCollection = readStringParam(rawParams, "parentCollection");

      let code: string;
      switch (action) {
        case "create":
          code = [
            "import bpy",
            `col = bpy.data.collections.new(${JSON.stringify(collectionName)})`,
            parentCollection
              ? `parent = bpy.data.collections.get(${JSON.stringify(parentCollection)}) or bpy.context.scene.collection\nparent.children.link(col)`
              : `bpy.context.scene.collection.children.link(col)`,
          ].join("\n");
          break;
        case "delete":
          code = [
            "import bpy",
            `col = bpy.data.collections.get(${JSON.stringify(collectionName)})`,
            `if col: bpy.data.collections.remove(col)`,
          ].join("\n");
          break;
        case "hide":
          code = [
            "import bpy",
            `layer_col = bpy.context.view_layer.layer_collection.children.get(${JSON.stringify(collectionName)})`,
            `if layer_col: layer_col.hide_viewport = True`,
          ].join("\n");
          break;
        case "show":
          code = [
            "import bpy",
            `layer_col = bpy.context.view_layer.layer_collection.children.get(${JSON.stringify(collectionName)})`,
            `if layer_col: layer_col.hide_viewport = False`,
          ].join("\n");
          break;
        case "move_object":
          if (!objectName) return jsonResult("objectName is required for move_object action.");
          code = [
            "import bpy",
            `obj = bpy.data.objects.get(${JSON.stringify(objectName)})`,
            `col = bpy.data.collections.get(${JSON.stringify(collectionName)})`,
            `if not obj: raise ValueError(f"Object not found: ${objectName}")`,
            `if not col: raise ValueError(f"Collection not found: ${collectionName}")`,
            `for c in obj.users_collection: c.objects.unlink(obj)`,
            `col.objects.link(obj)`,
          ].join("\n");
          break;
        default:
          return jsonResult(`Unknown action: ${action}`);
      }

      const result = await client.execute(code);
      if (!result.ok) return jsonResult(`Collection action failed: ${result.error}`);
      return jsonResult(`Collection '${collectionName}': ${action} succeeded.`);
    },
  };
}

export function createSetRenderSettingsTool(api: OpenClawPluginApi) {
  return {
    name: "blender_set_render_settings",
    label: "Blender: Set Render Settings",
    description:
      "Configure the Blender render engine, resolution, sample count, output path, format, frame range, " +
      "denoising, and transparency. Use this to set up render pipelines before calling blender_render.",
    parameters: SetRenderSettingsSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const { client, error } = await requireLiveBridge(api);
      if (!client) return jsonResult(error!);

      const lines: string[] = ["import bpy", "scene = bpy.context.scene", "r = scene.render"];
      const applied: string[] = [];

      const engine = readStringParam(rawParams, "engine");
      if (engine) {
        lines.push(`r.engine = ${JSON.stringify(engine)}`);
        applied.push(`engine=${engine}`);
      }

      const rx = rawParams["resolutionX"] as number | undefined;
      const ry = rawParams["resolutionY"] as number | undefined;
      if (rx) {
        lines.push(`r.resolution_x = ${rx}`);
        applied.push(`resolution_x=${rx}`);
      }
      if (ry) {
        lines.push(`r.resolution_y = ${ry}`);
        applied.push(`resolution_y=${ry}`);
      }

      const rp = rawParams["resolutionPercent"] as number | undefined;
      if (rp) {
        lines.push(`r.resolution_percentage = ${rp}`);
        applied.push(`resolution_percent=${rp}`);
      }

      const samples = rawParams["samples"] as number | undefined;
      if (samples) {
        lines.push(
          `if r.engine == 'CYCLES': scene.cycles.samples = ${samples}`,
          `elif r.engine == 'BLENDER_EEVEE_NEXT': scene.eevee.taa_render_samples = ${samples}`,
        );
        applied.push(`samples=${samples}`);
      }

      const fps = rawParams["fps"] as number | undefined;
      if (fps) {
        lines.push(`scene.render.fps = ${fps}`);
        applied.push(`fps=${fps}`);
      }

      const fs = rawParams["frameStart"] as number | undefined;
      const fe = rawParams["frameEnd"] as number | undefined;
      if (fs !== undefined) {
        lines.push(`scene.frame_start = ${fs}`);
        applied.push(`frame_start=${fs}`);
      }
      if (fe !== undefined) {
        lines.push(`scene.frame_end = ${fe}`);
        applied.push(`frame_end=${fe}`);
      }

      const outputPath = readStringParam(rawParams, "outputPath");
      if (outputPath) {
        lines.push(`r.filepath = ${JSON.stringify(outputPath)}`);
        applied.push(`output=${outputPath}`);
      }

      const outputFormat = readStringParam(rawParams, "outputFormat");
      if (outputFormat) {
        lines.push(`r.image_settings.file_format = ${JSON.stringify(outputFormat)}`);
        applied.push(`format=${outputFormat}`);
      }

      const denoising = rawParams["useDenoising"] as boolean | undefined;
      if (denoising !== undefined) {
        lines.push(`scene.cycles.use_denoising = ${denoising ? "True" : "False"}`);
        applied.push(`denoising=${denoising}`);
      }

      const transparent = rawParams["transparentBackground"] as boolean | undefined;
      if (transparent !== undefined) {
        lines.push(`r.film_transparent = ${transparent ? "True" : "False"}`);
        applied.push(`transparent=${transparent}`);
      }

      const result = await client.execute(lines.join("\n"));
      if (!result.ok) return jsonResult(`Failed to apply render settings: ${result.error}`);
      return jsonResult(`Render settings applied: ${applied.join(", ") || "(none changed)"}`);
    },
  };
}
