// Opt-in synthetic call-graph pressure, owned by the CPU-profile benchmark preload.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";

export async function createLargeGraphWorkload() {
  const dist = path.dirname(path.resolve(process.argv[1]));
  const providers = [
    "openai",
    "anthropic",
    "google",
    "openrouter",
    "github-copilot",
    "amazon-bedrock",
    "amazon-bedrock-mantle",
    "anthropic-vertex",
    "arcee",
    "baseten",
    "byteplus",
    "cerebras",
    "chutes",
    "cloudflare-ai-gateway",
    "cohere",
    "deepinfra",
    "deepseek",
    "fal",
    "featherless",
    "fireworks",
    "gmi",
    "groq",
    "huggingface",
    "kilocode",
    "venice",
    "longcat",
    "microsoft-foundry",
    "minimax",
    "mistral",
    "moonshot",
    "novita",
    "nvidia",
    "qianfan",
    "qwen",
    "stepfun",
    "together",
    "xai",
  ];
  // Import real bundled code, without calling registration or activating providers.
  for (const id of providers) {
    await import(pathToFileURL(path.join(dist, "extensions", id, "index.js")).href);
  }
  const chainCount = 1_280;
  const depth = 24;
  const chains = Array.from({ length: chainCount }, (_, chain) => {
    const name = (frame) => `syntheticChain${chain}Frame${frame}`;
    const source = Array.from(
      { length: depth },
      (_unused, frame) =>
        `function ${name(frame)}(ms) { ${
          frame + 1 < depth
            ? `return ${name(frame + 1)}(ms) + 1;`
            : "const end = performance.now() + ms; let result = 0; while (performance.now() < end) result++; return result;"
        } }`,
    ).join("\n");
    // Distinct source locations make separate sampled stacks, rather than hot clones.
    return compileFunction(`${source}\nreturn ${name(0)};`, [], {
      filename: `synthetic-cpu-graph-${chain}.js`,
    })();
  });
  for (const chain of chains) {
    chain(0);
  }
  let timer;
  let turns = 0;
  let active = false;
  let busyMs = 0;
  let busyCpuMs = 0;
  let maxSliceMs = 0;
  const tick = () => {
    const started = performance.now();
    const cpu = process.threadCpuUsage();
    chains[turns % chainCount](20);
    const used = process.threadCpuUsage(cpu);
    const elapsed = performance.now() - started;
    busyMs += elapsed;
    busyCpuMs += (used.user + used.system) / 1000;
    maxSliceMs = Math.max(maxSliceMs, elapsed);
    turns++;
    if (active) {
      timer = setTimeout(tick, 10);
      timer.unref();
    }
  };
  return {
    start() {
      turns = 0;
      busyMs = busyCpuMs = maxSliceMs = 0;
      active = true;
      timer = setTimeout(tick, 0);
      timer.unref();
    },
    stop() {
      active = false;
      clearTimeout(timer);
    },
    snapshot() {
      return {
        providers,
        chainCount,
        depth,
        turns,
        distinctChains: Math.min(turns, chainCount),
        active,
        busyMs,
        busyCpuMs,
        maxSliceMs,
      };
    },
  };
}
