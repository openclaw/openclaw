import fs from "node:fs";
import { pathToFileURL } from "node:url";

const providerKeys = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function resolveLiveModels(env = process.env) {
  const list = env.OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS;
  const legacy = env.OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI || "0";
  const explicit = list !== undefined && list !== "";
  if (!explicit && legacy !== "0" && legacy !== "1") {
    throw new Error("OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI must be 0 or 1");
  }
  const refs = explicit
    ? list.trim().split(/\s+/u).filter(Boolean)
    : legacy === "1"
      ? [env.OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_MODEL || "openai/gpt-5.5"]
      : [];
  if (explicit && refs.length === 0) {
    throw new Error("OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS must contain at least one model ref");
  }
  const seen = new Set();
  const counts = new Map();
  const models = refs.map((model) => {
    const match = /^(anthropic|google|openai)\/([^\s/]+)$/u.exec(model);
    if (!match) {
      throw new Error(`Unsupported live model ref ${model}; use anthropic/, google/, or openai/`);
    }
    if (seen.has(model)) {
      throw new Error(`Duplicate live model ref: ${model}`);
    }
    seen.add(model);
    const provider = match[1];
    const keyEnv = providerKeys[provider];
    if (!env[keyEnv]?.trim()) {
      throw new Error(
        explicit
          ? `Live model ${model} requires ${keyEnv}`
          : "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI=1 requires OPENAI_API_KEY",
      );
    }
    const count = (counts.get(provider) || 0) + 1;
    counts.set(provider, count);
    const artifact = `live-${provider}${count === 1 ? "" : `-${count}`}`;
    return { model, provider, keyEnv, artifact };
  });
  return {
    source: explicit
      ? "OPENCLAW_UPGRADE_SURVIVOR_LIVE_MODELS"
      : legacy === "1"
        ? "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI"
        : null,
    overridesLiveOpenai: explicit && legacy === "1",
    models,
  };
}

function main() {
  const [command, file, artifactName, status, latency] = process.argv.slice(2);
  if (command === "record") {
    const summary = JSON.parse(fs.readFileSync(file, "utf8"));
    const result = summary.models.find((entry) => entry.artifact === artifactName);
    if (!result) {
      throw new Error(`Unknown live artifact: ${artifactName}`);
    }
    Object.assign(result, { ok: status === "0", latencyMs: Number(latency) });
    fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const selection = resolveLiveModels();
  if (command === "rows") {
    for (const { model, provider, keyEnv, artifact } of selection.models) {
      console.log([model, provider, keyEnv, artifact].join("\t"));
    }
  } else if (command === "init") {
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          ...selection,
          models: selection.models.map(({ model, provider, artifact }) => ({
            model,
            provider,
            artifact,
            ok: false,
            latencyMs: null,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    throw new Error(`Unknown live-models command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
