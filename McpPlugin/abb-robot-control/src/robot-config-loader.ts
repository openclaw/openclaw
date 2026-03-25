/**
 * robot-config-loader.ts
 * Load and validate robot configuration files for actual ABB robots
 * Supports automatic robot identification based on DH parameters and joint limits
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

export interface DHParameter {
  jointId: string;
  d: number;
  theta: number;
  a: number;
  alpha: number;
}

export interface SequenceStep {
  joints: number[];
  durationMs: number;
  speed?: number;
  zone?: string;
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
  dof: number;
  mechanismType?: string;
  joints: JointConfig[];
  dhParameters?: DHParameter[];
  linkOffsets?: Array<{
    jointId: string;
    translation: [number, number, number];
    rotation: [number, number, number];
  }>;
  gravity?: [number, number, number];
  presets?: Record<string, number[]>;
  sequences?: Record<string, Sequence>;
  
  // ABB-specific fields
  abbModel?: string;
  abbSerialNumber?: string;
  workObject?: string;
  tool?: string;
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * List all available robot configuration IDs
 */
export function listRobots(): string[] {
  try {
    if (!fs.existsSync(ROBOTS_DIR)) {
      return [];
    }
    return fs
      .readdirSync(ROBOTS_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("robot-config"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Load a robot configuration by ID
 */
export function loadRobotConfig(robotId: string): RobotConfig {
  const safeName = path.basename(robotId);
  const filePath = path.join(ROBOTS_DIR, `${safeName}.json`);

  if (!fs.existsSync(filePath)) {
    const available = listRobots();
    throw new Error(
      `Robot config not found: "${robotId}". Available: ${available.join(", ") || "(none)"}`
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
 * Identify robot configuration from controller data
 * Matches based on DH parameters and joint limits
 */
export function identifyRobot(
  joints: JointConfig[],
  dhParams?: DHParameter[]
): string | null {
  const configs = listRobots();
  
  for (const configId of configs) {
    try {
      const config = loadRobotConfig(configId);
      
      // Check DOF match
      if (config.dof !== joints.length) continue;
      
      // Check joint limits match (with tolerance)
      let limitsMatch = true;
      for (let i = 0; i < joints.length; i++) {
        const configJoint = config.joints[i];
        const testJoint = joints[i];
        
        if (Math.abs(configJoint.min - testJoint.min) > 1.0 ||
            Math.abs(configJoint.max - testJoint.max) > 1.0) {
          limitsMatch = false;
          break;
        }
      }
      
      if (!limitsMatch) continue;
      
      // Check DH parameters if provided
      if (dhParams && config.dhParameters) {
        let dhMatch = true;
        for (let i = 0; i < dhParams.length; i++) {
          const configDH = config.dhParameters[i];
          const testDH = dhParams[i];
          
          if (Math.abs(configDH.d - testDH.d) > 0.01 ||
              Math.abs(configDH.a - testDH.a) > 0.01 ||
              Math.abs(configDH.alpha - testDH.alpha) > 0.01) {
            dhMatch = false;
            break;
          }
        }
        
        if (!dhMatch) continue;
      }
      
      // Found a match
      return configId;
    } catch {
      continue;
    }
  }
  
  return null;
}

/**
 * Clamp a joint value to configured limits
 */
export function clampJoint(cfg: JointConfig, value: number): number {
  return Math.max(cfg.min, Math.min(cfg.max, value));
}

/**
 * Validate joint values against robot configuration
 */
export function validateJointValues(
  config: RobotConfig,
  values: number[]
): { values: number[]; violations: string[] } {
  const violations: string[] = [];
  const sanitised = config.joints.map((joint, i) => {
    const raw = values[i] ?? joint.home;
    if (raw < joint.min || raw > joint.max) {
      violations.push(
        `${joint.label ?? joint.id}: ${raw.toFixed(2)} out of range [${joint.min}, ${joint.max}]`
      );
    }
    return clampJoint(joint, raw);
  });
  return { values: sanitised, violations };
}

/**
 * Resolve a named preset to joint values
 */
export function resolvePreset(config: RobotConfig, presetName: string): number[] {
  const presets = config.presets ?? {};
  if (!(presetName in presets)) {
    throw new Error(
      `Unknown preset "${presetName}" for robot "${config.id}". ` +
      `Available: ${Object.keys(presets).join(", ") || "(none)"}`
    );
  }
  const { values } = validateJointValues(config, presets[presetName]);
  return values;
}

/**
 * Resolve a named sequence with validated joint values
 */
export function resolveSequence(config: RobotConfig, sequenceName: string): Sequence {
  const sequences = config.sequences ?? {};
  if (!(sequenceName in sequences)) {
    throw new Error(
      `Unknown sequence "${sequenceName}" for robot "${config.id}". ` +
      `Available: ${Object.keys(sequences).join(", ") || "(none)"}`
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

// ── Validation ───────────────────────────────────────────────────────────────

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
        `Robot config "${id}": joint "${j.id}" min (${j.min}) > max (${j.max})`
      );
    }
  }

  return obj as unknown as RobotConfig;
}
