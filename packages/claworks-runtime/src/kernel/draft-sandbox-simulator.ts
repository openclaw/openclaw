/**
 * draft-sandbox-simulator.ts — 草稿 Playbook 沙盒冒烟（不写入生产 Pack）
 *
 * 临时 load → PlaybookSimulator 干跑 → unload，失败不抛错。
 */
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { parsePlaybookYaml } from "../pack-loader/yaml-parsers.js";
import { runSandboxPlaybookSimulation } from "./sandbox-playbook-runner.js";

export type DraftSimulationResult = {
  yaml_valid: boolean;
  passed: boolean;
  status: "ok" | "error" | "skipped";
  reason?: string;
  error?: string;
  duration_ms?: number;
  step_count?: number;
};

export async function simulateDraftPlaybook(
  runtime: ClaworksRuntime,
  opts: {
    playbookYaml: string;
    playbookId: string;
    proposalId: string;
    testPayload?: Record<string, unknown>;
  },
): Promise<DraftSimulationResult> {
  const source = `sandbox-draft:${opts.proposalId}`;
  let loaded = false;
  const pb = runtime.playbookEngine;
  const pbExt = pb as typeof pb & {
    loadFromYaml?: (yaml: string, src: string) => Promise<void>;
    unload?: (id: string) => void;
  };

  try {
    const playbookDef = parsePlaybookYaml(opts.playbookYaml, source);

    if (typeof pbExt.load === "function") {
      pbExt.load(playbookDef);
      loaded = true;
    } else if (typeof pbExt.loadFromYaml === "function") {
      await pbExt.loadFromYaml(opts.playbookYaml, source);
      loaded = true;
    } else {
      return {
        yaml_valid: true,
        passed: false,
        status: "error",
        reason: "playbookEngine.load / loadFromYaml 不可用",
      };
    }

    const result = await runSandboxPlaybookSimulation(pbExt, opts.playbookId, {
      testPayload: opts.testPayload,
      triggerEventType: `draft.review.${opts.playbookId}`,
      draftReview: true,
    });

    return {
      yaml_valid: true,
      passed: result.passed,
      status: result.status === "ok" ? "ok" : "error",
      error: result.error,
      duration_ms: result.duration_ms,
      step_count: result.step_count,
    };
  } catch (err) {
    return {
      yaml_valid: true,
      passed: false,
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (loaded) {
      try {
        pbExt.unload?.(opts.playbookId);
      } catch {
        // unload 失败不阻断 suggestions_ready
      }
    }
  }
}
