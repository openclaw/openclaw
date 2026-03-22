import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readStringParam,
  stringEnum,
  optionalStringEnum,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { createBlenderClient, resolveBlenderConfig } from "../client.js";

const BAKE_TYPES = ["DIFFUSE", "AO", "NORMAL", "ROUGHNESS", "EMIT", "COMBINED"] as const;
const TEXTURE_TYPES = ["BASE_COLOR", "NORMAL", "ROUGHNESS", "METALLIC", "AO", "EMISSION"] as const;
const COLOR_SPACES = ["sRGB", "Non-Color", "Linear"] as const;
const ALPHA_MODES = ["OPAQUE", "CLIP", "BLEND"] as const;

const ApplyMaterialSchema = Type.Object({
  objectName: Type.String({ description: "Name of the object to apply the material to." }),
  materialName: Type.String({
    description: "Name of the material. Creates a new PBR material if it doesn't exist.",
  }),
  baseColor: Type.Optional(
    Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()], {
      description:
        "Base color as RGBA values in linear space (0.0-1.0). Example: [1.0, 0.2, 0.2, 1.0] for red.",
    }),
  ),
  metallic: Type.Optional(
    Type.Number({
      description: "Metallic value (0.0 = dielectric, 1.0 = full metal).",
      minimum: 0,
      maximum: 1,
    }),
  ),
  roughness: Type.Optional(
    Type.Number({
      description: "Roughness value (0.0 = mirror, 1.0 = fully diffuse).",
      minimum: 0,
      maximum: 1,
    }),
  ),
  emissionColor: Type.Optional(
    Type.Tuple([Type.Number(), Type.Number(), Type.Number()], {
      description: "Emission color [R, G, B] in linear space.",
    }),
  ),
  emissionStrength: Type.Optional(
    Type.Number({ description: "Emission strength multiplier (0 = off).", minimum: 0 }),
  ),
  alphaMode: optionalStringEnum(ALPHA_MODES, {
    description: "Alpha blending mode for transparency.",
  }),
  useNodes: Type.Optional(
    Type.Boolean({
      description: "Use Principled BSDF shader nodes (default: true).",
    }),
  ),
});

const BakeTexturesSchema = Type.Object({
  objectName: Type.String({ description: "Name of the mesh object to bake." }),
  outputDir: Type.String({ description: "Directory where baked textures will be saved." }),
  resolution: Type.Optional(
    Type.Number({
      description: "Texture resolution in pixels (e.g. 1024, 2048, 4096). Default: 2048.",
      minimum: 64,
    }),
  ),
  bakeTypes: Type.Optional(
    Type.Array(stringEnum(BAKE_TYPES, { description: "Bake map type." }), {
      description:
        "Which maps to bake. Defaults to ['DIFFUSE', 'AO', 'NORMAL', 'ROUGHNESS']. " +
        "COMBINED = full beauty bake (requires light setup).",
    }),
  ),
  margin: Type.Optional(
    Type.Number({
      description: "Pixel margin around UV islands to prevent seam bleeding (default: 16).",
      minimum: 0,
    }),
  ),
  selectedToActive: Type.Optional(
    Type.Boolean({
      description:
        "Bake from high-poly (selected) to low-poly (active object). Select high-poly objects first, then run.",
    }),
  ),
});

const TextureAssignSchema = Type.Object({
  objectName: Type.String({ description: "Name of the object." }),
  materialName: Type.String({ description: "Name of the material to modify." }),
  textureType: stringEnum(TEXTURE_TYPES, {
    description: "Which PBR slot to connect the texture to.",
  }),
  texturePath: Type.String({ description: "Absolute path to the texture image file." }),
  colorSpace: optionalStringEnum(COLOR_SPACES, {
    description:
      "Color space override. Auto-detected by default: color textures = sRGB, data textures = Non-Color.",
  }),
});

function getClient(api: OpenClawPluginApi) {
  const cfg = resolveBlenderConfig(api.pluginConfig);
  return createBlenderClient({ host: cfg.host, port: cfg.port });
}

export function createApplyMaterialTool(api: OpenClawPluginApi) {
  return {
    name: "blender_apply_material",
    label: "Blender: Apply Material",
    description:
      "Create or update a Principled BSDF material and apply it to a mesh object. " +
      "Set base color, metallic, roughness, emission, and transparency in one call. " +
      "Ideal for quickly setting up game-ready PBR materials.",
    parameters: ApplyMaterialSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const objectName = readStringParam(rawParams, "objectName", { required: true })!;
      const materialName = readStringParam(rawParams, "materialName", { required: true })!;
      const baseColor = rawParams["baseColor"] as [number, number, number, number] | undefined;
      const metallic = rawParams["metallic"] as number | undefined;
      const roughness = rawParams["roughness"] as number | undefined;
      const emissionColor = rawParams["emissionColor"] as [number, number, number] | undefined;
      const emissionStrength = rawParams["emissionStrength"] as number | undefined;
      const alphaMode = readStringParam(rawParams, "alphaMode");
      const useNodes = (rawParams["useNodes"] as boolean | undefined) ?? true;

      const client = getClient(api);
      const status = await client.status();
      if (!status.running) return jsonResult("Blender bridge is not running.");

      const lines: string[] = [
        "import bpy",
        `obj = bpy.data.objects.get(${JSON.stringify(objectName)})`,
        `if not obj: raise ValueError(f"Object not found: ${objectName}")`,
        `mat = bpy.data.materials.get(${JSON.stringify(materialName)})`,
        `if not mat:`,
        `    mat = bpy.data.materials.new(name=${JSON.stringify(materialName)})`,
        `mat.use_nodes = ${useNodes ? "True" : "False"}`,
      ];

      if (useNodes) {
        lines.push(
          `bsdf = mat.node_tree.nodes.get('Principled BSDF')`,
          `if not bsdf:`,
          `    mat.node_tree.nodes.clear()`,
          `    bsdf = mat.node_tree.nodes.new('ShaderNodeBsdfPrincipled')`,
          `    out = mat.node_tree.nodes.new('ShaderNodeOutputMaterial')`,
          `    mat.node_tree.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])`,
        );

        if (baseColor) {
          lines.push(`bsdf.inputs['Base Color'].default_value = (${baseColor.join(", ")})`);
        }
        if (metallic !== undefined) {
          lines.push(`bsdf.inputs['Metallic'].default_value = ${metallic}`);
        }
        if (roughness !== undefined) {
          lines.push(`bsdf.inputs['Roughness'].default_value = ${roughness}`);
        }
        if (emissionColor) {
          lines.push(
            `bsdf.inputs['Emission Color'].default_value = (${emissionColor.join(", ")}, 1.0)`,
          );
        }
        if (emissionStrength !== undefined) {
          lines.push(`bsdf.inputs['Emission Strength'].default_value = ${emissionStrength}`);
        }
      }

      if (alphaMode) {
        lines.push(`mat.blend_method = ${JSON.stringify(alphaMode)}`);
      }

      lines.push(
        `if obj.data.materials:`,
        `    obj.data.materials[0] = mat`,
        `else:`,
        `    obj.data.materials.append(mat)`,
      );

      const result = await client.execute(lines.join("\n"));
      if (!result.ok) return jsonResult(`Failed to apply material: ${result.error}`);
      return jsonResult(`Applied material '${materialName}' to '${objectName}'.`);
    },
  };
}

export function createBakeTexturesTool(api: OpenClawPluginApi) {
  return {
    name: "blender_bake_textures",
    label: "Blender: Bake Textures",
    description:
      "Bake texture maps (Diffuse, AO, Normal, Roughness, Emission, Combined) from a Blender material " +
      "to UV-unwrapped image textures. Produces game-engine-ready PBR texture sets. " +
      "Supports high-poly to low-poly baking (selectedToActive mode).",
    parameters: BakeTexturesSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const objectName = readStringParam(rawParams, "objectName", { required: true })!;
      const outputDir = readStringParam(rawParams, "outputDir", { required: true })!;
      const resolution = (rawParams["resolution"] as number | undefined) ?? 2048;
      const bakeTypes = (rawParams["bakeTypes"] as string[] | undefined) ?? [
        "DIFFUSE",
        "AO",
        "NORMAL",
        "ROUGHNESS",
      ];
      const margin = (rawParams["margin"] as number | undefined) ?? 16;
      const selectedToActive = (rawParams["selectedToActive"] as boolean | undefined) ?? false;

      const client = getClient(api);
      const status = await client.status();
      if (!status.running) return jsonResult("Blender bridge is not running.");

      const lines: string[] = [
        "import bpy, os",
        "scene = bpy.context.scene",
        "scene.render.engine = 'CYCLES'",
        `obj = bpy.data.objects.get(${JSON.stringify(objectName)})`,
        `if not obj: raise ValueError(f"Object not found: ${objectName}")`,
        `os.makedirs(${JSON.stringify(outputDir)}, exist_ok=True)`,
        `bpy.ops.object.select_all(action='DESELECT')`,
        `obj.select_set(True)`,
        `bpy.context.view_layer.objects.active = obj`,
        `baked = []`,
      ];

      for (const bakeType of bakeTypes) {
        const imgName = `${objectName}_${bakeType.toLowerCase()}_${resolution}`;
        const outPath = `${outputDir}/${imgName}.png`;
        lines.push(
          `img = bpy.data.images.new(${JSON.stringify(imgName)}, width=${resolution}, height=${resolution})`,
          `img.filepath_raw = ${JSON.stringify(outPath)}`,
          `for mat in obj.data.materials:`,
          `    if mat and mat.use_nodes:`,
          `        nodes = mat.node_tree.nodes`,
          `        tex_node = nodes.new('ShaderNodeTexImage')`,
          `        tex_node.image = img`,
          `        nodes.active = tex_node`,
          `bpy.ops.object.bake(`,
          `    type=${JSON.stringify(bakeType)},`,
          `    use_selected_to_active=${selectedToActive ? "True" : "False"},`,
          `    margin=${margin},`,
          `    use_clear=True,`,
          `)`,
          `img.save_render(${JSON.stringify(outPath)})`,
          `baked.append(${JSON.stringify(outPath)})`,
          `for mat in obj.data.materials:`,
          `    if mat and mat.use_nodes:`,
          `        for n in [n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image == img]:`,
          `            mat.node_tree.nodes.remove(n)`,
        );
      }

      lines.push(`print('Baked:', baked)`);

      const result = await client.execute(lines.join("\n"));
      if (!result.ok) return jsonResult(`Bake failed: ${result.error}`);
      return jsonResult(
        `Baked ${bakeTypes.length} map(s) for '${objectName}' at ${resolution}px -> ${outputDir}\n` +
          bakeTypes.map((t) => `  - ${t}`).join("\n"),
      );
    },
  };
}

export function createAssignTextureTool(api: OpenClawPluginApi) {
  return {
    name: "blender_assign_texture",
    label: "Blender: Assign Texture",
    description:
      "Connect a texture image file to a specific PBR slot (Base Color, Normal, Roughness, etc.) " +
      "in a Principled BSDF material. Automatically sets the correct color space. " +
      "Use after importing assets or baking textures to wire up your material graph.",
    parameters: TextureAssignSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const objectName = readStringParam(rawParams, "objectName", { required: true })!;
      const materialName = readStringParam(rawParams, "materialName", { required: true })!;
      const textureType = readStringParam(rawParams, "textureType", { required: true })!;
      const texturePath = readStringParam(rawParams, "texturePath", { required: true })!;
      const colorSpace = readStringParam(rawParams, "colorSpace");

      const dataTextures = new Set(["NORMAL", "ROUGHNESS", "METALLIC", "AO"]);
      const autoColorSpace = dataTextures.has(textureType) ? "Non-Color" : "sRGB";
      const cs = colorSpace ?? autoColorSpace;

      const bsdfInputMap: Record<string, string> = {
        BASE_COLOR: "Base Color",
        NORMAL: "Normal",
        ROUGHNESS: "Roughness",
        METALLIC: "Metallic",
        AO: "Base Color",
        EMISSION: "Emission Color",
      };
      const bsdfInput = bsdfInputMap[textureType] ?? "Base Color";
      const isNormal = textureType === "NORMAL";

      const lines: string[] = [
        "import bpy",
        `obj = bpy.data.objects.get(${JSON.stringify(objectName)})`,
        `if not obj: raise ValueError(f"Object not found: ${objectName}")`,
        `mat = obj.data.materials.get(${JSON.stringify(materialName)})`,
        `if not mat: raise ValueError(f"Material not found: ${materialName}")`,
        `if not mat.use_nodes: mat.use_nodes = True`,
        `nodes = mat.node_tree.nodes`,
        `links = mat.node_tree.links`,
        `bsdf = nodes.get('Principled BSDF')`,
        `if not bsdf: raise ValueError("Principled BSDF node not found in material")`,
        `img = bpy.data.images.load(${JSON.stringify(texturePath)}, check_existing=True)`,
        `img.colorspace_settings.name = ${JSON.stringify(cs)}`,
        `tex_node = nodes.new('ShaderNodeTexImage')`,
        `tex_node.image = img`,
      ];

      if (isNormal) {
        lines.push(
          `nm = nodes.new('ShaderNodeNormalMap')`,
          `links.new(tex_node.outputs['Color'], nm.inputs['Color'])`,
          `links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])`,
        );
      } else {
        lines.push(
          `links.new(tex_node.outputs['Color'], bsdf.inputs[${JSON.stringify(bsdfInput)}])`,
        );
      }

      const client = getClient(api);
      const status = await client.status();
      if (!status.running) return jsonResult("Blender bridge is not running.");

      const result = await client.execute(lines.join("\n"));
      if (!result.ok) return jsonResult(`Failed to assign texture: ${result.error}`);
      return jsonResult(
        `Assigned ${textureType} texture to '${materialName}' on '${objectName}'. Color space: ${cs}.`,
      );
    },
  };
}
