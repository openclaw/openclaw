/**
 * robot-config-loader.ts
 * Loads and validates robot configuration JSON files from the robots/ directory.
 * Supports dynamic multi-robot selection at runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROBOTS_DIR = path.resolve(__dirname, "../robots");

// ── Types ────────────────────────────────────────────────────────────────────

export interface JointConfig {
  index: number;
  id: string;
  label?: string;
  type: "revolute" | "prismatic";
  min: number;
  max: number;
  speed?: number;
  home: number;
  axis?: [number, number, number];
  unit?: "deg" | "rad" | "mm" | "m";
}

export interface SequenceStep {
  joints: number[];
  durationMs: number;
}

export interface Sequence {
  description?: string;
  steps: SequenceStep[];
}

export interface RobotConfig {
  id: string;
  version: string;
  manufacturer: string;
  model: string;
  description?: string;
  glbFile?: string;
  dof: number;
  mechanismType?: string;
  joints: JointConfig[];
  dhParameters?: Array<{ jointId: string; d: number; theta: number; a: number; alpha: number }>;
  presets?: Record<string, number[]>;
  sequences?: Record<string, Sequence>;
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * List all robot IDs available in the robots/ directory.
 */
export function listRobots(): string[] {
  try {
    return fs
      .readdirSync(ROBOTS_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("robot-config"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Load and parse a robot config by ID.
 * Throws if the file is missing or fails basic validation.
 */
export function loadRobotConfig(robotId: string): RobotConfig {
  const safeName = path.basename(robotId); // prevent path traversal
  const filePath = path.join(ROBOTS_DIR, `${safeName}.json`);

  if (!fs.existsSync(filePath)) {
    const available = listRobots();
    throw new Error(
      `Robot config not found: "${robotId}". Available robots: ${available.join(", ") || "(none)"}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse robot config "${robotId}": ${String(err)}`);
  }

  return validateConfig(raw, robotId);
}

/**
 * Clamp a joint value to the configured [min, max] range.
 */
export function clampJoint(cfg: JointConfig, value: number): number {
  return Math.max(cfg.min, Math.min(cfg.max, value));
}

/**
 * Validate all joints in a values array against the robot config.
 * Returns sanitised (clamped) values and a list of any violations.
 */
export function validateJointValues(
  config: RobotConfig,
  values: number[],
): { values: number[]; violations: string[] } {
  const violations: string[] = [];
  const sanitised = config.joints.map((joint, i) => {
    const raw = values[i] ?? joint.home;
    if (raw < joint.min || raw > joint.max) {
      violations.push(
        `${joint.label ?? joint.id}: ${raw.toFixed(2)} out of range [${joint.min}, ${joint.max}]`,
      );
    }
    return clampJoint(joint, raw);
  });
  return { values: sanitised, violations };
}

/**
 * Validate a named preset exists and return its (clamped) joint values.
 */
export function resolvePreset(config: RobotConfig, presetName: string): number[] {
  const presets = config.presets ?? {};
  if (!(presetName in presets)) {
    throw new Error(
      `Unknown preset "${presetName}" for robot "${config.id}". ` +
        `Available: ${Object.keys(presets).join(", ") || "(none)"}`,
    );
  }
  const { values } = validateJointValues(config, presets[presetName]);
  return values;
}

/**
 * Validate a named sequence exists and return it with all steps clamped.
 */
export function resolveSequence(config: RobotConfig, sequenceName: string): Sequence {
  const sequences = config.sequences ?? {};
  if (!(sequenceName in sequences)) {
    throw new Error(
      `Unknown sequence "${sequenceName}" for robot "${config.id}". ` +
        `Available: ${Object.keys(sequences).join(", ") || "(none)"}`,
    );
  }
  const seq = sequences[sequenceName];
  return {
    ...seq,
    steps: seq.steps.map((step) => ({
      ...step,
      joints: validateJointValues(config, step.joints).values,
    })),
  };
}

// ── Internal validation ──────────────────────────────────────────────────────

function validateConfig(raw: unknown, id: string): RobotConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Robot config "${id}" is not a valid JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj["joints"]) || (obj["joints"] as unknown[]).length === 0) {
    throw new Error(`Robot config "${id}" must have a non-empty joints array`);
  }

  const joints = obj["joints"] as JointConfig[];
  for (const j of joints) {
    if (typeof j.min !== "number" || typeof j.max !== "number") {
      throw new Error(`Robot config "${id}": joint "${j.id}" missing numeric min/max`);
    }
    if (j.min > j.max) {
      throw new Error(
        `Robot config "${id}": joint "${j.id}" min (${j.min}) > max (${j.max})`,
      );
    }
  }

  return obj as unknown as RobotConfig;
}

