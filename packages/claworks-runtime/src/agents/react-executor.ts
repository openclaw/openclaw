import type { ClaworksRuntime } from "../claworks/runtime-types.js";

export type ReactAction = {
  capability: string;
  params: Record<string, unknown>;
};

export type ReactIteration = {
  iteration: number;
  thought: string;
  action: ReactAction;
  observation: unknown;
  done: boolean;
  conclusion?: string;
};

export type ReactResult = {
  goal: string;
  iterations: ReactIteration[];
  conclusion: string;
  success: boolean;
};

/** 能力前缀黑名单（安全保护）*/
const BLOCKED_PREFIXES = ["security.", "governance.", "evolve.deploy", "evolve.remove"];

function isSafeCapability(capId: string): boolean {
  return !BLOCKED_PREFIXES.some((p) => capId.startsWith(p));
}

function extractJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    return null;
  }
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export async function runReact(
  goal: string,
  tools: string[],
  maxIterations: number,
  runtime: ClaworksRuntime,
  ctx: { sessionId: string; userId: string; source: string },
): Promise<ReactResult> {
  const kernel = runtime.kernel as unknown as {
    listCapabilities?: () => Array<{ id: string }>;
    callCapability?: (id: string, ctx: unknown, params: unknown) => Promise<unknown>;
  };

  const registered = kernel.listCapabilities?.().map((c) => c.id) ?? [];
  const safeTools = tools.filter((t) => registered.includes(t) && isSafeCapability(t));

  const iterations: ReactIteration[] = [];
  let done = false;
  let conclusion = "";

  const llm = runtime.llmComplete ?? runtime.bridges?.get("llm")?.complete;

  for (let i = 0; i < maxIterations && !done; i++) {
    const history =
      iterations.length > 0
        ? iterations
            .map(
              (it) =>
                `迭代${it.iteration}→思考:${it.thought}→执行:${it.action.capability}` +
                `→结果:${JSON.stringify(it.observation).slice(0, 150)}`,
            )
            .join("\n")
        : "（无）";

    const prompt =
      `目标：${goal}\n` +
      `可用工具：${safeTools.join(", ") || "（无）"}\n` +
      `历史：${history}\n\n` +
      `请决定下一步，返回JSON：{"thought":"思考","action":{"capability":"能力ID","params":{}},"done":false,"conclusion":"若完成则填写"}`;

    let decision: {
      thought?: string;
      action?: { capability: string; params: Record<string, unknown> };
      done?: boolean;
      conclusion?: string;
    };

    try {
      if (!llm) {
        throw new Error("LLM 未配置");
      }
      const res = await llm({ prompt });
      const parsed = extractJson(res.text);
      if (parsed && typeof parsed === "object") {
        decision = parsed as typeof decision;
      } else {
        decision = {
          thought: "JSON 解析失败",
          action: { capability: safeTools[0] ?? "", params: {} },
          done: true,
          conclusion: "LLM 返回格式错误，执行终止",
        };
      }
    } catch (e) {
      decision = {
        thought: `LLM 调用失败: ${e instanceof Error ? e.message : String(e)}`,
        action: { capability: "", params: {} },
        done: true,
        conclusion: "执行失败",
      };
    }

    const capId = decision.action?.capability ?? "";
    let observation: unknown;

    try {
      if (capId && safeTools.includes(capId) && kernel.callCapability) {
        observation = await kernel.callCapability(capId, ctx, decision.action?.params ?? {});
      } else if (capId) {
        observation = { error: `工具 ${capId} 不在安全白名单中` };
      } else {
        observation = { skipped: true, reason: "未指定工具" };
      }
    } catch (e) {
      observation = { error: e instanceof Error ? e.message : String(e) };
    }

    const iter: ReactIteration = {
      iteration: i + 1,
      thought: decision.thought ?? "",
      action: {
        capability: capId,
        params: decision.action?.params ?? {},
      },
      observation,
      done: !!decision.done,
      conclusion: decision.conclusion,
    };
    iterations.push(iter);

    if (decision.done) {
      done = true;
      conclusion = decision.conclusion ?? "";
    }
  }

  return {
    goal,
    iterations,
    conclusion: conclusion || `完成 ${iterations.length} 次迭代`,
    success: done,
  };
}
