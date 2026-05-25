/**
 * draft-sandbox-simulator.ts — 草稿 Playbook 沙盒冒烟（不写入生产 Pack）
 *
 * 模式对齐 EvolutionSyncManager.runSandboxRegression：
 * 临时 load → PlaybookSimulator 干跑 → unload，失败不抛错。
 */
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { parsePlaybookYaml } from "../pack-loader/yaml-parsers.js";
import type { SimulateStepLog } from "../planes/orch/playbook-simulator.js";

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

    const { createPlaybookSimulator } = await import("../planes/orch/playbook-simulator.js");
    const simulator = createPlaybookSimulator(async (pid, initVars, trigEvent) => {
      const steps: SimulateStepLog[] = [];
      if (!pbExt.trigger) {
        return { steps, error: "playbookEngine.trigger 不可用" };
      }
      try {
        const run = await pbExt.trigger(
          pid,
          typeof trigEvent === "object" && trigEvent !== null && !Array.isArray(trigEvent)
            ? (trigEvent as Record<string, unknown>)
            : {},
          {
            variables: { ...initVars, _simulate: true, _sandbox: true, _draft_review: true },
          },
        );
        if (run?.steps) {
          for (let i = 0; i < run.steps.length; i++) {
            const s = run.steps[i]!;
            const durationMs =
              s.completedAt && s.startedAt ? s.completedAt.getTime() - s.startedAt.getTime() : 0;
            steps.push({
              step: i,
              type: s.stepId,
              name: s.stepId,
              status: s.status === "failed" ? "error" : "ok",
              durationMs,
              output: s.output,
              error: s.error,
            });
          }
        }
        return { steps, error: run.error };
      } catch (e) {
        return { steps, error: String(e) };
      }
    });

    const result = await simulator.simulate(
      opts.playbookId,
      { _simulate: true, _sandbox: true, _draft_review: true },
      { type: `draft.review.${opts.playbookId}` },
    );

    return {
      yaml_valid: true,
      passed: result.status === "ok",
      status: result.status === "ok" ? "ok" : "error",
      error: result.error,
      duration_ms: result.duration_ms,
      step_count: result.steps.length,
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
