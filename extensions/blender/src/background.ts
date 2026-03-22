/**
 * Run Blender in headless background mode for batch operations.
 * Used when no interactive Blender session is open.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BackgroundResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

/**
 * Execute a Python script in Blender background mode.
 * Optionally open an existing .blend file first.
 */
export async function runBlenderBackground(params: {
  blenderExecutable: string;
  blendFile?: string;
  pythonCode: string;
  timeoutMs?: number;
}): Promise<BackgroundResult> {
  const { blenderExecutable, blendFile, pythonCode, timeoutMs = 120_000 } = params;

  // Write python code to a temp file
  const scriptPath = join(tmpdir(), `openclaw_blender_${randomUUID()}.py`);
  await writeFile(scriptPath, pythonCode, "utf-8");

  const args: string[] = ["--background"];
  if (blendFile) args.push(blendFile);
  args.push("--python", scriptPath);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(blenderExecutable, args, { env: process.env });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      unlink(scriptPath).catch(() => {});
      resolve({
        ok: !timedOut && exitCode === 0,
        stdout,
        stderr: timedOut ? `Timed out after ${timeoutMs}ms\n${stderr}` : stderr,
        exitCode,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      unlink(scriptPath).catch(() => {});
      resolve({
        ok: false,
        stdout,
        stderr: `Failed to spawn Blender: ${err.message}\n${stderr}`,
        exitCode: null,
      });
    });
  });
}

/** Build Python code to render a scene in background mode. */
export function buildBackgroundRenderScript(params: {
  outputPath: string;
  frameStart?: number;
  frameEnd?: number;
  engine?: string;
  resolutionX?: number;
  resolutionY?: number;
  samples?: number;
  camera?: string;
}): string {
  const lines: string[] = ["import bpy", "scene = bpy.context.scene"];

  if (params.engine) lines.push(`scene.render.engine = ${JSON.stringify(params.engine)}`);
  if (params.resolutionX) lines.push(`scene.render.resolution_x = ${params.resolutionX}`);
  if (params.resolutionY) lines.push(`scene.render.resolution_y = ${params.resolutionY}`);
  if (params.camera) {
    lines.push(
      `cam = bpy.data.objects.get(${JSON.stringify(params.camera)})`,
      `if cam: scene.camera = cam`,
    );
  }
  if (params.samples) {
    lines.push(
      `if scene.render.engine == 'CYCLES': scene.cycles.samples = ${params.samples}`,
      `elif scene.render.engine == 'BLENDER_EEVEE_NEXT': scene.eevee.taa_render_samples = ${params.samples}`,
    );
  }

  lines.push(`scene.render.filepath = ${JSON.stringify(params.outputPath)}`);

  if (params.frameStart !== undefined && params.frameEnd !== undefined) {
    lines.push(
      `scene.frame_start = ${params.frameStart}`,
      `scene.frame_end = ${params.frameEnd}`,
      `bpy.ops.render.render(animation=True)`,
    );
  } else {
    lines.push(`bpy.ops.render.render(write_still=True)`);
  }

  return lines.join("\n");
}

/** Build Python code to export an asset in background mode. */
export function buildBackgroundExportScript(params: {
  outputPath: string;
  format: string;
  selectionOnly?: boolean;
  applyModifiers?: boolean;
  exportAnimations?: boolean;
}): string {
  const {
    outputPath,
    format,
    selectionOnly = false,
    applyModifiers = true,
    exportAnimations = false,
  } = params;

  switch (format.toUpperCase()) {
    case "FBX":
      return [
        "import bpy",
        `bpy.ops.export_scene.fbx(`,
        `  filepath=${JSON.stringify(outputPath)},`,
        `  use_selection=${selectionOnly ? "True" : "False"},`,
        `  use_mesh_modifiers=${applyModifiers ? "True" : "False"},`,
        `  bake_anim=${exportAnimations ? "True" : "False"},`,
        `)`,
      ].join("\n");

    case "GLTF":
    case "GLB":
      return [
        "import bpy",
        `bpy.ops.export_scene.gltf(`,
        `  filepath=${JSON.stringify(outputPath)},`,
        `  export_format=${"GLB" === format.toUpperCase() ? "'GLB'" : "'GLTF_EMBEDDED'"},`,
        `  use_selection=${selectionOnly ? "True" : "False"},`,
        `  export_apply=${applyModifiers ? "True" : "False"},`,
        `  export_animations=${exportAnimations ? "True" : "False"},`,
        `)`,
      ].join("\n");

    case "OBJ":
      return [
        "import bpy",
        `bpy.ops.wm.obj_export(`,
        `  filepath=${JSON.stringify(outputPath)},`,
        `  export_selected_objects=${selectionOnly ? "True" : "False"},`,
        `  apply_modifiers=${applyModifiers ? "True" : "False"},`,
        `)`,
      ].join("\n");

    case "USD":
    case "USDC":
    case "USDA":
      return [
        "import bpy",
        `bpy.ops.wm.usd_export(`,
        `  filepath=${JSON.stringify(outputPath)},`,
        `  selected_objects_only=${selectionOnly ? "True" : "False"},`,
        `  export_animation=${exportAnimations ? "True" : "False"},`,
        `)`,
      ].join("\n");

    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}
