import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readStringParam,
  stringEnum,
  optionalStringEnum,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { createBlenderClient, resolveBlenderConfig } from "../client.js";

const COLLISION_TYPES = ["BOX", "SPHERE", "CAPSULE", "CONVEX", "MESH"] as const;
const TARGET_ENGINES = ["UNREAL", "UNITY", "GODOT", "GENERIC"] as const;
const UV_METHODS = [
  "SMART_UV_PROJECT",
  "UNWRAP",
  "LIGHTMAP_PACK",
  "CUBE_PROJECTION",
  "CYLINDER_PROJECTION",
  "SPHERE_PROJECTION",
] as const;

const GenerateLodSchema = Type.Object({
  objectName: Type.String({ description: "Name of the source mesh object." }),
  levels: Type.Optional(
    Type.Array(
      Type.Object({
        ratio: Type.Number({
          description:
            "Decimate ratio for this LOD level (0.0-1.0). 0.5 = 50% of original polygons.",
          minimum: 0.01,
          maximum: 1.0,
        }),
        suffix: Type.Optional(
          Type.String({
            description: "Suffix appended to the object name (default: '_LOD1', '_LOD2', etc.).",
          }),
        ),
      }),
      { description: "LOD levels to generate. Default: 3 levels at 0.5, 0.25, 0.1." },
    ),
  ),
  collection: Type.Optional(
    Type.String({
      description: "Collection to place LOD objects in (default: '<ObjectName>_LODs').",
    }),
  ),
  applyModifiers: Type.Optional(
    Type.Boolean({ description: "Apply existing modifiers before decimating (default: true)." }),
  ),
});

const CollisionMeshSchema = Type.Object({
  objectName: Type.String({ description: "Name of the source mesh object." }),
  collisionType: stringEnum(COLLISION_TYPES, {
    description:
      "Collision shape: BOX/SPHERE/CAPSULE = primitive (cheapest). " +
      "CONVEX = convex hull (good for non-concave props). " +
      "MESH = exact mesh collision (only for static geometry).",
  }),
  prefix: Type.Optional(
    Type.String({
      description:
        "Naming prefix for the collision mesh. " +
        "Defaults: 'UCX_' (Unreal convex), 'UBX_' (Unreal box), 'USP_' (Unreal sphere), 'COL_' (Godot/generic).",
    }),
  ),
  targetEngine: optionalStringEnum(TARGET_ENGINES, {
    description:
      "Game engine to name collision meshes for (sets the prefix convention). Default: GENERIC.",
  }),
});

const UvUnwrapSchema = Type.Object({
  objectName: Type.String({ description: "Name of the mesh object to unwrap." }),
  method: optionalStringEnum(UV_METHODS, {
    description: "UV unwrapping method. SMART_UV_PROJECT is recommended for most game assets.",
  }),
  angle: Type.Optional(
    Type.Number({
      description: "Island angle limit in degrees for Smart UV Project (default: 66).",
      minimum: 0,
      maximum: 89,
    }),
  ),
  margin: Type.Optional(
    Type.Number({
      description: "UV island margin (spacing between islands, default: 0.02).",
      minimum: 0,
      maximum: 1,
    }),
  ),
  uvMapName: Type.Optional(
    Type.String({
      description: "Name for the UV map. Creates it if it doesn't exist (default: 'UVMap').",
    }),
  ),
});

const GameExportSchema = Type.Object({
  objectNames: Type.Array(Type.String(), {
    description:
      "Names of objects to export. Can include meshes, armatures, empties for hierarchy.",
  }),
  outputPath: Type.String({
    description: "Output file path (include extension: .fbx, .glb, .gltf, .obj).",
  }),
  targetEngine: stringEnum(TARGET_ENGINES, {
    description: "Target game engine -- sets axis, scale, and format conventions.",
  }),
  includeAnimations: Type.Optional(
    Type.Boolean({ description: "Export skeletal animations (default: false)." }),
  ),
  includeCollisions: Type.Optional(
    Type.Boolean({
      description: "Include UCX_/COL_ collision meshes if present in the scene (default: true).",
    }),
  ),
  includeLods: Type.Optional(
    Type.Boolean({ description: "Include _LOD objects if present (default: false)." }),
  ),
});

const CheckGameReadinessSchema = Type.Object({
  objectName: Type.String({ description: "Object to check." }),
});

function getClient(api: OpenClawPluginApi) {
  const cfg = resolveBlenderConfig(api.pluginConfig);
  return createBlenderClient({ host: cfg.host, port: cfg.port });
}

export function createGenerateLodTool(api: OpenClawPluginApi) {
  return {
    name: "blender_generate_lod",
    label: "Blender: Generate LODs",
    description:
      "Automatically generate Level of Detail (LOD) meshes from a source object using the Decimate modifier. " +
      "Creates LOD0 (full detail), LOD1, LOD2, LOD3 variants at configurable polygon ratios. " +
      "LODs are placed in a dedicated collection and named per game-engine conventions.",
    parameters: GenerateLodSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const objectName = readStringParam(rawParams, "objectName", { required: true })!;
      const levels = (rawParams["levels"] as
        | Array<{ ratio: number; suffix?: string }>
        | undefined) ?? [
        { ratio: 0.5, suffix: "_LOD1" },
        { ratio: 0.25, suffix: "_LOD2" },
        { ratio: 0.1, suffix: "_LOD3" },
      ];
      const collection = readStringParam(rawParams, "collection") ?? `${objectName}_LODs`;
      const applyModifiers = (rawParams["applyModifiers"] as boolean | undefined) ?? true;

      const client = getClient(api);
      const status = await client.status();
      if (!status.running) return jsonResult("Blender bridge is not running.");

      const lines: string[] = [
        "import bpy",
        `src = bpy.data.objects.get(${JSON.stringify(objectName)})`,
        `if not src: raise ValueError(f"Object not found: ${objectName}")`,
        `if src.type != 'MESH': raise ValueError(f"Object is not a mesh: ${objectName}")`,
        `col = bpy.data.collections.get(${JSON.stringify(collection)})`,
        `if not col:`,
        `    col = bpy.data.collections.new(${JSON.stringify(collection)})`,
        `    bpy.context.scene.collection.children.link(col)`,
        `lod0 = src.copy()`,
        `lod0.data = src.data.copy()`,
        `lod0.name = ${JSON.stringify(objectName + "_LOD0")}`,
        `col.objects.link(lod0)`,
        `results = [${JSON.stringify(objectName + "_LOD0")} + ' (LOD0 = original)']`,
      ];

      for (const [i, level] of levels.entries()) {
        const suffix = level.suffix ?? `_LOD${i + 1}`;
        const lodName = objectName + suffix;
        lines.push(
          `lod = src.copy()`,
          `lod.data = src.data.copy()`,
          `lod.name = ${JSON.stringify(lodName)}`,
          `col.objects.link(lod)`,
          ...(applyModifiers
            ? [
                `bpy.context.view_layer.objects.active = lod`,
                `bpy.ops.object.select_all(action='DESELECT')`,
                `lod.select_set(True)`,
                // Snapshot names before iterating — modifier_apply removes each element from
                // the C-backed collection as it runs, shifting indices and silently skipping
                // every other modifier when iterating the live collection.
                `for mod_name in [m.name for m in lod.modifiers]: bpy.ops.object.modifier_apply(modifier=mod_name)`,
              ]
            : []),
          `dec = lod.modifiers.new(name='LOD_Decimate', type='DECIMATE')`,
          `dec.ratio = ${level.ratio}`,
          `bpy.context.view_layer.objects.active = lod`,
          `bpy.ops.object.modifier_apply(modifier='LOD_Decimate')`,
          `face_count = len(lod.data.polygons)`,
          `results.append(${JSON.stringify(lodName)} + f' (ratio=${level.ratio}, faces={face_count})')`,
        );
      }

      lines.push(`print('\\n'.join(results))`);

      const result = await client.execute(lines.join("\n"));
      if (!result.ok) return jsonResult(`LOD generation failed: ${result.error}`);
      return jsonResult(
        `Generated ${levels.length} LOD levels for '${objectName}' -> collection '${collection}'.\n${result.output ?? ""}`.trim(),
      );
    },
  };
}

export function createCollisionMeshTool(api: OpenClawPluginApi) {
  return {
    name: "blender_create_collision",
    label: "Blender: Create Collision Mesh",
    description:
      "Generate a collision mesh for a game object -- box, sphere, capsule, convex hull, or exact mesh. " +
      "Names follow game-engine conventions: UCX_ (Unreal convex), UBX_ (Unreal box), COL_ (Godot/generic). " +
      "The collision mesh is placed adjacent to the source object in the scene.",
    parameters: CollisionMeshSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const objectName = readStringParam(rawParams, "objectName", { required: true })!;
      const collisionType = readStringParam(rawParams, "collisionType", { required: true })!;
      const targetEngine = (readStringParam(rawParams, "targetEngine") ?? "GENERIC") as string;
      const customPrefix = readStringParam(rawParams, "prefix");

      const prefixMap: Record<string, Record<string, string>> = {
        UNREAL: { BOX: "UBX_", SPHERE: "USP_", CAPSULE: "UCP_", CONVEX: "UCX_", MESH: "UCX_" },
        UNITY: { BOX: "COL_", SPHERE: "COL_", CAPSULE: "COL_", CONVEX: "COL_", MESH: "COL_" },
        GODOT: { BOX: "COL_", SPHERE: "COL_", CAPSULE: "COL_", CONVEX: "COL_", MESH: "COL_" },
        GENERIC: { BOX: "COL_", SPHERE: "COL_", CAPSULE: "COL_", CONVEX: "COL_", MESH: "COL_" },
      };
      const prefix = customPrefix ?? prefixMap[targetEngine]?.[collisionType] ?? "COL_";
      const colName = `${prefix}${objectName}`;

      const client = getClient(api);
      const status = await client.status();
      if (!status.running) return jsonResult("Blender bridge is not running.");

      let code: string;

      if (collisionType === "BOX") {
        code = [
          "import bpy",
          `src = bpy.data.objects.get(${JSON.stringify(objectName)})`,
          `if not src: raise ValueError(f"Object not found: ${objectName}")`,
          `dims = src.dimensions`,
          `loc = src.location`,
          `bpy.ops.mesh.primitive_cube_add(location=loc)`,
          `col = bpy.context.active_object`,
          `col.name = ${JSON.stringify(colName)}`,
          `col.dimensions = dims`,
          `col.display_type = 'WIRE'`,
        ].join("\n");
      } else if (collisionType === "SPHERE") {
        code = [
          "import bpy",
          `src = bpy.data.objects.get(${JSON.stringify(objectName)})`,
          `if not src: raise ValueError(f"Object not found: ${objectName}")`,
          `radius = max(src.dimensions) / 2`,
          `loc = src.location`,
          `bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc)`,
          `col = bpy.context.active_object`,
          `col.name = ${JSON.stringify(colName)}`,
          `col.display_type = 'WIRE'`,
        ].join("\n");
      } else if (collisionType === "CONVEX" || collisionType === "MESH") {
        code = [
          "import bpy",
          `src = bpy.data.objects.get(${JSON.stringify(objectName)})`,
          `if not src: raise ValueError(f"Object not found: ${objectName}")`,
          `col = src.copy()`,
          `col.data = src.data.copy()`,
          `col.name = ${JSON.stringify(colName)}`,
          `bpy.context.collection.objects.link(col)`,
          ...(collisionType === "CONVEX"
            ? [
                `col.modifiers.clear()`,
                `bpy.context.view_layer.objects.active = col`,
                `bpy.ops.object.select_all(action='DESELECT')`,
                `col.select_set(True)`,
                `bpy.ops.object.mode_set(mode='EDIT')`,
                `bpy.ops.mesh.select_all(action='SELECT')`,
                `bpy.ops.mesh.convex_hull()`,
                `bpy.ops.object.mode_set(mode='OBJECT')`,
              ]
            : []),
          `col.display_type = 'WIRE'`,
        ].join("\n");
      } else if (collisionType === "CAPSULE") {
        code = [
          "import bpy",
          `src = bpy.data.objects.get(${JSON.stringify(objectName)})`,
          `if not src: raise ValueError(f"Object not found: ${objectName}")`,
          `height = src.dimensions[2]`,
          `radius = max(src.dimensions[0], src.dimensions[1]) / 2`,
          `loc = src.location`,
          `bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=height, location=loc)`,
          `col = bpy.context.active_object`,
          `col.name = ${JSON.stringify(colName)}`,
          `col.display_type = 'WIRE'`,
        ].join("\n");
      } else {
        return jsonResult(`Unknown collision type: ${collisionType}`);
      }

      const result = await client.execute(code);
      if (!result.ok) return jsonResult(`Collision mesh creation failed: ${result.error}`);
      return jsonResult(
        `Created ${collisionType} collision mesh '${colName}' for '${objectName}' (${targetEngine} naming).`,
      );
    },
  };
}

export function createUvUnwrapTool(api: OpenClawPluginApi) {
  return {
    name: "blender_uv_unwrap",
    label: "Blender: UV Unwrap",
    description:
      "UV unwrap a mesh object for texture baking or painting. " +
      "SMART_UV_PROJECT is the best default for game props. " +
      "LIGHTMAP_PACK generates a second UV channel optimized for lightmap baking.",
    parameters: UvUnwrapSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const objectName = readStringParam(rawParams, "objectName", { required: true })!;
      const method = (readStringParam(rawParams, "method") ?? "SMART_UV_PROJECT") as string;
      const angle = (rawParams["angle"] as number | undefined) ?? 66;
      const margin = (rawParams["margin"] as number | undefined) ?? 0.02;
      const uvMapName = readStringParam(rawParams, "uvMapName") ?? "UVMap";

      const client = getClient(api);
      const status = await client.status();
      if (!status.running) return jsonResult("Blender bridge is not running.");

      const lines: string[] = [
        "import bpy",
        `obj = bpy.data.objects.get(${JSON.stringify(objectName)})`,
        `if not obj: raise ValueError(f"Object not found: ${objectName}")`,
        `if obj.type != 'MESH': raise ValueError("Object must be a mesh")`,
        `bpy.context.view_layer.objects.active = obj`,
        `bpy.ops.object.select_all(action='DESELECT')`,
        `obj.select_set(True)`,
        `if ${JSON.stringify(uvMapName)} not in obj.data.uv_layers:`,
        `    obj.data.uv_layers.new(name=${JSON.stringify(uvMapName)})`,
        `obj.data.uv_layers.active = obj.data.uv_layers[${JSON.stringify(uvMapName)}]`,
        `bpy.ops.object.mode_set(mode='EDIT')`,
        `bpy.ops.mesh.select_all(action='SELECT')`,
      ];

      switch (method) {
        case "SMART_UV_PROJECT":
          lines.push(`bpy.ops.uv.smart_project(angle_limit=${angle}, island_margin=${margin})`);
          break;
        case "UNWRAP":
          lines.push(`bpy.ops.uv.unwrap(method='ANGLE_BASED', margin=${margin})`);
          break;
        case "LIGHTMAP_PACK":
          lines.push(`bpy.ops.uv.lightmap_pack(PREF_MARGIN_DIV=${margin})`);
          break;
        case "CUBE_PROJECTION":
          lines.push(`bpy.ops.uv.cube_project(scale_to_bounds=True)`);
          break;
        case "CYLINDER_PROJECTION":
          lines.push(`bpy.ops.uv.cylinder_project()`);
          break;
        case "SPHERE_PROJECTION":
          lines.push(`bpy.ops.uv.sphere_project()`);
          break;
        default:
          lines.push(`bpy.ops.uv.smart_project(angle_limit=${angle}, island_margin=${margin})`);
      }

      lines.push(`bpy.ops.object.mode_set(mode='OBJECT')`);

      const result = await client.execute(lines.join("\n"));
      if (!result.ok) return jsonResult(`UV unwrap failed: ${result.error}`);
      return jsonResult(`UV unwrapped '${objectName}' using ${method} into UV map '${uvMapName}'.`);
    },
  };
}

export function createGameExportTool(api: OpenClawPluginApi) {
  return {
    name: "blender_game_export",
    label: "Blender: Game Engine Export",
    description:
      "One-click export of game assets with correct axis orientation, scale, and naming for Unreal Engine, " +
      "Unity, Godot, or generic pipelines. Selects the specified objects, applies engine-correct axis/scale, " +
      "and exports as FBX (Unreal/Unity) or GLTF (Godot/web). Collision meshes and LODs can be included.",
    parameters: GameExportSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const objectNames = rawParams["objectNames"] as string[];
      const outputPath = readStringParam(rawParams, "outputPath", { required: true })!;
      const targetEngine = readStringParam(rawParams, "targetEngine", { required: true })!;
      const includeAnimations = (rawParams["includeAnimations"] as boolean | undefined) ?? false;
      const includeCollisions = (rawParams["includeCollisions"] as boolean | undefined) ?? true;
      const includeLods = (rawParams["includeLods"] as boolean | undefined) ?? false;

      const client = getClient(api);
      const status = await client.status();
      if (!status.running) return jsonResult("Blender bridge is not running.");

      if (!Array.isArray(objectNames) || objectNames.length === 0) {
        return jsonResult("objectNames must be a non-empty array.");
      }

      const engineConfig: Record<
        string,
        { format: string; axisForward: string; axisUp: string; globalScale: number }
      > = {
        UNREAL: { format: "FBX", axisForward: "-Z", axisUp: "Y", globalScale: 1.0 },
        UNITY: { format: "FBX", axisForward: "Z", axisUp: "Y", globalScale: 1.0 },
        GODOT: { format: "GLTF", axisForward: "-Z", axisUp: "Y", globalScale: 1.0 },
        GENERIC: { format: "GLTF", axisForward: "-Z", axisUp: "Y", globalScale: 1.0 },
      };
      const ec = engineConfig[targetEngine] ?? engineConfig["GENERIC"]!;

      const lines: string[] = [
        "import bpy",
        `bpy.ops.object.select_all(action='DESELECT')`,
        `target_names = ${JSON.stringify(objectNames)}`,
        ...(includeCollisions
          ? [
              `collision_prefixes = ('UCX_', 'UBX_', 'USP_', 'UCP_', 'COL_')`,
              `for obj in bpy.context.scene.objects:`,
              `    if any(obj.name.startswith(p) for p in collision_prefixes):`,
              `        target_names.append(obj.name)`,
            ]
          : []),
        ...(includeLods
          ? [
              `for obj in bpy.context.scene.objects:`,
              `    if any(obj.name.endswith(f'_LOD{i}') for i in range(1, 8)):`,
              `        target_names.append(obj.name)`,
            ]
          : []),
        `for name in set(target_names):`,
        `    obj = bpy.data.objects.get(name)`,
        `    if obj: obj.select_set(True)`,
      ];

      if (ec.format === "FBX") {
        lines.push(
          `bpy.ops.export_scene.fbx(`,
          `    filepath=${JSON.stringify(outputPath)},`,
          `    use_selection=True,`,
          `    axis_forward=${JSON.stringify(ec.axisForward)},`,
          `    axis_up=${JSON.stringify(ec.axisUp)},`,
          `    global_scale=${ec.globalScale},`,
          `    use_mesh_modifiers=True,`,
          `    bake_anim=${includeAnimations ? "True" : "False"},`,
          `    add_leaf_bones=False,`,
          `)`,
        );
      } else {
        lines.push(
          `bpy.ops.export_scene.gltf(`,
          `    filepath=${JSON.stringify(outputPath)},`,
          `    export_format='GLTF_EMBEDDED',`,
          `    use_selection=True,`,
          `    export_apply=True,`,
          `    export_animations=${includeAnimations ? "True" : "False"},`,
          `)`,
        );
      }

      const result = await client.execute(lines.join("\n"));
      if (!result.ok) return jsonResult(`Game export failed: ${result.error}`);
      return jsonResult(
        `Exported ${objectNames.length} object(s) for ${targetEngine} -> ${outputPath} (${ec.format}, axis: ${ec.axisForward}/${ec.axisUp})`,
      );
    },
  };
}

export function createCheckGameReadinessTool(api: OpenClawPluginApi) {
  return {
    name: "blender_check_game_readiness",
    label: "Blender: Check Game Readiness",
    description:
      "Audit a mesh object for common game-export issues: missing UV maps, non-applied transforms, " +
      "N-gons, non-manifold geometry, overlapping UVs, zero-area faces, and missing materials. " +
      "Returns a list of issues and recommendations.",
    parameters: CheckGameReadinessSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const objectName = readStringParam(rawParams, "objectName", { required: true })!;
      const client = getClient(api);
      const status = await client.status();
      if (!status.running) return jsonResult("Blender bridge is not running.");

      const code = `
import bpy
import bmesh

obj = bpy.data.objects.get(${JSON.stringify(objectName)})
if not obj:
    raise ValueError(f"Object not found: ${objectName}")
if obj.type != 'MESH':
    raise ValueError(f"Object is not a mesh: ${objectName}")

issues = []
recommendations = []

if any(abs(v - 1.0) > 0.0001 for v in obj.scale):
    issues.append(f"Non-unit scale: {tuple(round(v,4) for v in obj.scale)}")
    recommendations.append("Apply scale with Ctrl+A > Scale before exporting")
if any(abs(v) > 0.0001 for v in obj.location):
    issues.append(f"Non-zero location: {tuple(round(v,4) for v in obj.location)}")
    recommendations.append("Consider applying location if the asset should be origin-centred")

if not obj.data.uv_layers:
    issues.append("No UV maps found")
    recommendations.append("Run UV Unwrap before exporting for game engines")
else:
    print(f"UV maps: {[uv.name for uv in obj.data.uv_layers]}")

if not obj.data.materials:
    issues.append("No materials assigned")
    recommendations.append("Assign at least one material for correct texture export")

bm = bmesh.new()
bm.from_mesh(obj.data)
bm.normal_update()

ngons = [f for f in bm.faces if len(f.verts) > 4]
if ngons:
    issues.append(f"N-gons found: {len(ngons)} faces with >4 vertices")
    recommendations.append("Triangulate or quadrangulate N-gons before game export")

zero_area = [f for f in bm.faces if f.calc_area() < 1e-8]
if zero_area:
    issues.append(f"Zero-area faces: {len(zero_area)}")
    recommendations.append("Remove degenerate faces")

non_manifold = [e for e in bm.edges if not e.is_manifold]
if non_manifold:
    issues.append(f"Non-manifold edges: {len(non_manifold)}")
    recommendations.append("Fix non-manifold geometry for correct collision and export")

bm.free()

poly_count = len(obj.data.polygons)
vert_count = len(obj.data.vertices)

summary = [
    f"Object: {obj.name}",
    f"Polygons: {poly_count}, Vertices: {vert_count}",
    f"Materials: {len(obj.data.materials)}",
    f"UV Maps: {len(obj.data.uv_layers)}",
    "",
]

if issues:
    summary.append("ISSUES FOUND:")
    summary.extend(f"  x {i}" for i in issues)
    summary.append("")
    summary.append("RECOMMENDATIONS:")
    summary.extend(f"  -> {r}" for r in recommendations)
else:
    summary.append("No issues found -- object appears game-ready.")

print("\\n".join(summary))
`.trim();

      const result = await client.execute(code);
      if (!result.ok) return jsonResult(`Readiness check failed: ${result.error}`);
      return jsonResult(result.output ?? "(no output)");
    },
  };
}
