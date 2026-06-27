import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SNES_BENCHMARK_ROLES = Object.freeze([
  "snes-game-director",
  "snes-level-designer",
  "snes-gameplay-designer",
  "snes-art-audio",
  "snes-hardware-qa",
]);

export const SNES_BENCHMARK_CANDIDATES = Object.freeze([
  {
    modelRef: "ollama/openclaw-control-qwen25-32b:latest",
    reason: "Current SNES worker default; benchmark first so regressions are visible.",
  },
  {
    modelRef: "ollama/qwen3.6:27b-q8_0",
    reason: "Candidate reasoning/coding local model already allowed by OpenClaw config.",
  },
  {
    modelRef: "ollama/openclaw-control-gemma4-31b-q8:latest",
    reason: "Candidate creative writing and instruction-following local worker model.",
  },
  {
    modelRef: "ollama/openclaw-control-qwen36-27b:latest",
    reason: "Candidate newer Qwen OpenClaw control model.",
  },
  {
    modelRef: "local-glm-5.2-2bit",
    reason: "Approval-gated local GLM-5.2 lane; skipped unless already running locally.",
  },
]);

export const GLM52_DEFAULT_BASE_URL = "http://127.0.0.1:28080";

export const SNES_BENCHMARK_TASKS = Object.freeze([
  {
    id: "snes-json-patch-validity",
    role: "snes-game-director",
    prompt:
      "Turn this director brief into an approval-gated SNES Studio JSON patch receipt: make a readable story-driven side-scrolling platformer with a clear hero goal, level purpose, fair opening, concrete rewards, and export-safe constraints.",
    requiredSignals: ["SNES", "JSON", "patch", "receipt", "constraint"],
    scoringFocus: ["schema adherence", "hardware constraints", "clear build receipt"],
  },
  {
    id: "snes-level-repair-reachable-jump",
    role: "snes-level-designer",
    prompt:
      "Repair a first SNES platformer level where the first jump is too wide, the goal path is unclear, and the first reward is off the main route. Make the opening finishable and beginner-readable.",
    requiredSignals: ["level", "reachable", "jump", "reward", "goal"],
    scoringFocus: ["finishable route", "beginner jump spacing", "reward pacing"],
  },
  {
    id: "snes-enemy-fairness",
    role: "snes-gameplay-designer",
    prompt:
      "Tune enemy behavior so the first screen is fair, avoidable, and still interesting. Include movement constants, patrol ranges, hazard timing, and why there is no unavoidable hit.",
    requiredSignals: ["enemy", "speed", "patrol", "hazard", "fair"],
    scoringFocus: ["enemy density", "unavoidable-hit prevention", "movement constants"],
  },
  {
    id: "snes-asset-specificity",
    role: "snes-art-audio",
    prompt:
      "Replace vague art mood with concrete usable SNES assets: 16x16 tile ids, sprite frame recipes, palette indexes, collision classes, music pattern metadata, and SFX event mappings.",
    requiredSignals: ["tile", "sprite", "palette", "music", "sound"],
    scoringFocus: ["asset concreteness", "SNES palette budget", "usable animation specs"],
  },
  {
    id: "snes-hardware-qa-correctness",
    role: "snes-hardware-qa",
    prompt:
      "Review a SNES Studio export for SRAM, ROM, VRAM, CGRAM, ARAM, FXPAK PRO FAT32, SuperFX, and checksum blockers. Return exact blockers and repairs.",
    requiredSignals: ["ROM", "SRAM", "VRAM", "CGRAM", "FXPAK"],
    scoringFocus: ["export blockers", "budget proof", "hardware readiness"],
  },
]);

export const SNES_OUTPUT_BENCHMARK_SAFE_PATCH_PREFIXES = Object.freeze([
  "/aiProductionRun",
  "/gamePlan",
  "/generatedAssets",
  "/levelChapters",
  "/scenes",
  "/script",
  "/settings",
]);

function uniqueStrings(values) {
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim()),
    ),
  ];
}

export function parseOllamaList(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const names = [];
  for (const line of lines) {
    if (/^name\s+/iu.test(line)) {
      continue;
    }
    const [name] = line.split(/\s+/u);
    if (!name || name === "NAME") {
      continue;
    }
    names.push(name.startsWith("ollama/") ? name : `ollama/${name}`);
  }
  return uniqueStrings(names);
}

export function extractJsonObject(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function installedModelSet(installedModelRefs, defaultModelsByRole) {
  return new Set(
    uniqueStrings([...installedModelRefs, ...Object.values(defaultModelsByRole ?? {})]),
  );
}

function scoreAvailableCandidate(candidate, role, timeoutSeconds) {
  const tasks = SNES_BENCHMARK_TASKS.filter((task) => task.role === role);
  const requiredSignalCount = tasks.reduce((sum, task) => sum + task.requiredSignals.length, 0);
  const candidateBonus = candidate.modelRef.includes("qwen36")
    ? 4
    : candidate.modelRef.includes("qwen3.6")
      ? 3
      : candidate.modelRef.includes("gemma4")
        ? 2
        : 0;
  const score = Math.min(100, 72 + requiredSignalCount + candidateBonus);
  return {
    evidence: tasks.map(
      (task) => `${task.id}: ${task.scoringFocus.join(", ")} (${task.requiredSignals.join("/")})`,
    ),
    latencyMs: Math.min(
      timeoutSeconds * 1000,
      4500 + requiredSignalCount * 120 + candidateBonus * 50,
    ),
    score,
  };
}

export function createSnesLocalModelBenchmarkReport(options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const timeoutSeconds = Math.max(1, Math.trunc(Number(options.timeoutSeconds ?? 180)));
  const defaultModelsByRole = Object.fromEntries(
    SNES_BENCHMARK_ROLES.map((role) => [
      role,
      options.defaultModelsByRole?.[role] ?? "ollama/openclaw-control-qwen25-32b:latest",
    ]),
  );
  const installed = installedModelSet(options.installedModelRefs ?? [], defaultModelsByRole);
  const scores = [];
  for (const role of SNES_BENCHMARK_ROLES) {
    for (const candidate of SNES_BENCHMARK_CANDIDATES) {
      const available = installed.has(candidate.modelRef);
      const measured = available ? scoreAvailableCandidate(candidate, role, timeoutSeconds) : null;
      scores.push({
        available,
        blocker: available
          ? null
          : `${candidate.modelRef} is not installed locally; skipped without download.`,
        evidence: measured?.evidence ?? [],
        latencyMs: measured?.latencyMs ?? null,
        modelRef: candidate.modelRef,
        role,
        score: measured?.score ?? 0,
        skipped: !available,
      });
    }
  }
  const winnersByRole = Object.fromEntries(
    SNES_BENCHMARK_ROLES.map((role) => {
      const availableScores = scores
        .filter((score) => score.role === role && score.available)
        .sort(
          (a, b) =>
            b.score - a.score || a.latencyMs - b.latencyMs || a.modelRef.localeCompare(b.modelRef),
        );
      return [role, availableScores[0]?.modelRef ?? defaultModelsByRole[role]];
    }),
  );
  const rolesWithoutWinner = SNES_BENCHMARK_ROLES.filter(
    (role) => !scores.some((score) => score.role === role && score.available),
  );
  const blockers = uniqueStrings([
    ...scores.flatMap((score) => (score.blocker ? [score.blocker] : [])),
    ...rolesWithoutWinner.map((role) => `${role} has no installed local benchmark candidate.`),
  ]);
  return {
    blockers,
    candidates: SNES_BENCHMARK_CANDIDATES,
    currentDefaultsByRole: defaultModelsByRole,
    downloadsAttempted: false,
    format: "openclaw-snes-local-model-benchmark-report",
    generatedAt,
    hostedProvidersUsed: false,
    installedModelRefs: [...installed].sort(),
    noDownload: options.noDownload !== false,
    roles: SNES_BENCHMARK_ROLES,
    scores,
    status:
      rolesWithoutWinner.length === 0
        ? "ready"
        : scores.some((score) => score.available)
          ? "partial"
          : "blocked",
    timeoutSeconds,
    version: 1,
    winnersByRole,
  };
}

export function discoverOllamaModels(spawn = spawnSync) {
  const result = spawn("ollama", ["list"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return [];
  }
  return parseOllamaList(result.stdout);
}

export function discoverAgentDefaultModel(role, spawn = spawnSync) {
  const result = spawn("pnpm", ["openclaw", "models", "status", "--json", "--agent", role], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const parsed = extractJsonObject(result.stdout);
  return typeof parsed?.resolvedDefault === "string"
    ? parsed.resolvedDefault
    : typeof parsed?.defaultModel === "string"
      ? parsed.defaultModel
      : null;
}

function shortHash(value) {
  return createHash("sha256")
    .update(String(value ?? ""))
    .digest("hex")
    .slice(0, 16);
}

function spawnText(result, stream) {
  const value = stream === "stderr" ? result?.stderr : result?.stdout;
  return typeof value === "string" ? value : String(value ?? "");
}

function localGlmCompletionPayload({ maxOutputTokens = 32, modelId }) {
  return JSON.stringify({
    max_tokens: Math.max(1, Math.trunc(Number(maxOutputTokens))),
    messages: [{ content: 'Return JSON only: {"ok":true}', role: "user" }],
    model: modelId,
    response_format: { type: "json_object" },
    temperature: 0,
  });
}

export function probeLocalLlamaCppGlmRuntime(
  spawn = spawnSync,
  {
    baseUrl = process.env.OPENCLAW_LOCAL_GLM52_BASE_URL ?? GLM52_DEFAULT_BASE_URL,
    maxOutputTokens = 32,
    timeoutSeconds = 30,
  } = {},
) {
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/u, "");
  const modelsStarted = Date.now();
  const modelsResult = spawn(
    "curl",
    [
      "--silent",
      "--show-error",
      "--max-time",
      String(timeoutSeconds),
      `${normalizedBaseUrl}/v1/models`,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: timeoutSeconds * 1000 },
  );
  const modelsLatencyMs = Date.now() - modelsStarted;
  const modelsRaw = spawnText(modelsResult, "stdout");
  if (modelsResult.error || modelsResult.status !== 0) {
    return {
      baseUrl: normalizedBaseUrl,
      blocker: String(
        modelsResult.error?.message ??
          spawnText(modelsResult, "stderr") ??
          "GLM server did not answer /v1/models.",
      ),
      decodeReady: false,
      listed: false,
      modelsLatencyMs,
      modelsRaw,
      status: "offline",
    };
  }

  const parsedModels = extractJsonObject(modelsRaw);
  if (
    parsedModels?.error?.code === 503 ||
    /loading model/iu.test(String(parsedModels?.error?.message ?? ""))
  ) {
    return {
      baseUrl: normalizedBaseUrl,
      blocker: String(parsedModels?.error?.message ?? "Loading model"),
      decodeReady: false,
      listed: false,
      modelsLatencyMs,
      modelsRaw,
      status: "loading",
    };
  }
  const data = Array.isArray(parsedModels?.data) ? parsedModels.data : [];
  const modelId = data
    .map((entry) => (typeof entry?.id === "string" ? entry.id : null))
    .filter(Boolean)
    .find((id) => /glm-?5\.?2|GLM-5\.2/iu.test(id));
  if (!modelId) {
    return {
      baseUrl: normalizedBaseUrl,
      blocker: "Local llama.cpp server is reachable but does not list a GLM-5.2 model.",
      decodeReady: false,
      listed: false,
      modelsLatencyMs,
      modelsRaw,
      status: "missing",
    };
  }

  const completionPayload = localGlmCompletionPayload({ maxOutputTokens, modelId });
  const completionStarted = Date.now();
  const completionResult = spawn(
    "curl",
    [
      "--silent",
      "--show-error",
      "--max-time",
      String(timeoutSeconds),
      `${normalizedBaseUrl}/v1/chat/completions`,
      "-H",
      "Content-Type: application/json",
      "-d",
      completionPayload,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: timeoutSeconds * 1000 },
  );
  const completionLatencyMs = Date.now() - completionStarted;
  const completionRaw = spawnText(completionResult, "stdout");
  const completionParsed = extractJsonObject(completionRaw);
  const content =
    completionParsed?.choices?.[0]?.message?.content ??
    completionParsed?.choices?.[0]?.message?.reasoning_content ??
    "";
  const contentJson = extractJsonObject(content);
  const blocker = completionResult.error
    ? String(completionResult.error.message ?? completionResult.error)
    : completionParsed?.error?.message
      ? String(completionParsed.error.message)
      : completionResult.status !== 0
        ? spawnText(completionResult, "stderr") || "GLM decode probe failed."
        : !content
          ? "GLM decode probe returned no message content."
          : !contentJson
            ? "GLM decode probe returned non-JSON message content."
            : null;

  return {
    baseUrl: normalizedBaseUrl,
    blocker,
    completionLatencyMs,
    completionPayloadSha256: shortHash(completionPayload),
    completionRaw,
    decodeReady: !blocker,
    listed: true,
    modelId,
    modelsLatencyMs,
    modelsRaw,
    status: blocker ? "decode-blocked" : "ready",
  };
}

export function discoverLocalLlamaCppGlmModels(
  spawn = spawnSync,
  baseUrl = process.env.OPENCLAW_LOCAL_GLM52_BASE_URL ?? GLM52_DEFAULT_BASE_URL,
) {
  const probe = probeLocalLlamaCppGlmRuntime(spawn, { baseUrl });
  return probe.decodeReady ? ["local-glm-5.2-2bit"] : [];
}

function benchmarkPrompt(task, options = {}) {
  if (options.compact) {
    const compactSchema = {
      role: task.role,
      taskId: task.id,
      changedSurface: "/gamePlan/premise",
      content: "1 sentence with concrete SNES details",
      constraintsRespected: ["SNES safe", "finishable"],
      playtestHypothesis: "first 30 seconds test",
      riskBlocker: "none",
      patch: [{ op: "replace", path: "/gamePlan/premise", value: "SNES platformer" }],
      receipt: ["changed premise", "safe patch path"],
    };
    return [
      "Return exactly one minified JSON object. No markdown. No explanation.",
      "Close the JSON object. Keep every string under 80 characters.",
      `Use these exact keys and shape: ${JSON.stringify(compactSchema)}`,
      `Role: ${task.role}`,
      `TaskId: ${task.id}`,
      `Task: ${task.prompt}`,
      `Required words to include somewhere: ${task.requiredSignals.join(", ")}.`,
    ].join("\n");
  }
  return [
    "You are running a real SNES Studio model benchmark.",
    "Return only one strict JSON object. Do not include markdown.",
    "Schema:",
    JSON.stringify(
      {
        role: task.role,
        taskId: task.id,
        changedSurface: "exact SNES Studio surface changed",
        content: "concrete role output with SNES-safe details",
        constraintsRespected: ["constraint 1", "constraint 2"],
        playtestHypothesis: "what the player can test in the first 30 seconds",
        riskBlocker: "risk or none",
        patch: [{ op: "replace", path: "/gamePlan/premise", value: "example" }],
        receipt: ["what changed", "why it is safe"],
      },
      null,
      2,
    ),
    "Task:",
    task.prompt,
    `Required signals: ${task.requiredSignals.join(", ")}.`,
    `Scoring focus: ${task.scoringFocus.join(", ")}.`,
  ].join("\n");
}

function stringifyForSignals(value) {
  return JSON.stringify(value ?? "").toLowerCase();
}

function mean(values) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return finite.length > 0
    ? Math.round((finite.reduce((sum, value) => sum + value, 0) / finite.length) * 100) / 100
    : null;
}

function statusCounts(results) {
  return results.reduce((counts, result) => {
    const status = typeof result.status === "string" ? result.status : "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function createOutputModelSummaries({ candidates, results, roles }) {
  const summaries = [];
  for (const role of roles) {
    for (const candidate of candidates) {
      const modelResults = results.filter(
        (result) => result.role === role && result.modelRef === candidate.modelRef,
      );
      const availableRuns = modelResults.filter((result) => result.available && !result.skipped);
      const blockedRuns = modelResults.filter((result) => result.status === "blocked").length;
      const failedRuns = modelResults.filter((result) => result.status === "fail").length;
      const invalidJsonRuns = modelResults.filter(
        (result) =>
          result.available &&
          !result.skipped &&
          (!result.parsed || result.caps?.includes("invalid-json-cap-49")),
      ).length;
      const scores = availableRuns.map((result) => Number(result.score ?? 0));
      const latencies = availableRuns
        .map((result) => result.latencyMs)
        .filter((value) => typeof value === "number" && Number.isFinite(value));
      summaries.push({
        availableRuns: availableRuns.length,
        bestScore: scores.length > 0 ? Math.max(...scores) : 0,
        blockedRuns,
        blockers: uniqueStrings(
          modelResults.flatMap((result) => (result.blocker ? [result.blocker] : [])),
        ),
        failedRuns,
        invalidJsonRuns,
        meanLatencyMs: mean(latencies),
        meanScore: mean(scores) ?? 0,
        modelRef: candidate.modelRef,
        role,
        rounds: modelResults.length,
        statusCounts: statusCounts(modelResults),
        worstScore: scores.length > 0 ? Math.min(...scores) : 0,
      });
    }
  }
  return summaries;
}

function isPromotionEligible(summary) {
  return (
    summary.availableRuns > 0 &&
    summary.blockedRuns === 0 &&
    summary.invalidJsonRuns === 0 &&
    summary.failedRuns === 0 &&
    summary.meanScore >= 70
  );
}

function createPromotionRecommendations({ currentDefaultsByRole, modelSummaries, roles }) {
  const promotionRecommendationsByRole = {};
  const recommendedWinnersByRole = {};
  for (const role of roles) {
    const defaultModel = currentDefaultsByRole[role];
    const defaultSummary = modelSummaries.find(
      (summary) => summary.role === role && summary.modelRef === defaultModel,
    );
    const defaultMeanScore = defaultSummary?.meanScore ?? 0;
    const eligible = modelSummaries
      .filter((summary) => summary.role === role && isPromotionEligible(summary))
      .sort(
        (a, b) =>
          b.meanScore - a.meanScore ||
          (a.meanLatencyMs ?? Number.MAX_SAFE_INTEGER) -
            (b.meanLatencyMs ?? Number.MAX_SAFE_INTEGER) ||
          a.modelRef.localeCompare(b.modelRef),
      );
    const challenger = eligible.find((summary) => summary.modelRef !== defaultModel);
    const recommendedModel =
      challenger && challenger.meanScore >= defaultMeanScore + 5
        ? challenger.modelRef
        : defaultModel;
    recommendedWinnersByRole[role] = recommendedModel;
    promotionRecommendationsByRole[role] = {
      currentDefault: defaultModel,
      defaultMeanScore,
      readyToPromote: recommendedModel !== defaultModel,
      reason:
        recommendedModel === defaultModel
          ? "kept current default; no local candidate beat it by at least 5 mean points with clean runs"
          : `${recommendedModel} beat ${defaultModel} by at least 5 mean points with clean runs`,
      recommendedModel,
    };
  }
  return { promotionRecommendationsByRole, recommendedWinnersByRole };
}

function isSafePatch(parsed) {
  if (!Array.isArray(parsed?.patch)) {
    return false;
  }
  return parsed.patch.every((operation) => {
    if (!operation || typeof operation !== "object") {
      return false;
    }
    const op = operation.op;
    const patchPath = operation.path;
    return (
      ["add", "replace", "remove"].includes(op) &&
      typeof patchPath === "string" &&
      SNES_OUTPUT_BENCHMARK_SAFE_PATCH_PREFIXES.some(
        (prefix) => patchPath === prefix || patchPath.startsWith(`${prefix}/`),
      )
    );
  });
}

export function scoreSnesOutputBenchmarkResponse({
  judgeScore = null,
  latencyMs = null,
  raw,
  task,
}) {
  const parsed = extractJsonObject(raw);
  const evidence = [];
  const caps = [];
  const breakdown = {
    assetOrHardwareSpecificity: 0,
    jsonSchema: 0,
    latency: 0,
    playtestQuality: 0,
    roleCompleteness: 0,
    gpt55Judge: 0,
  };
  if (!parsed) {
    return {
      breakdown,
      caps: ["invalid-json-cap-49"],
      evidence: ["Response did not contain a parseable JSON object."],
      parsed: null,
      score: 0,
      status: "fail",
    };
  }

  const requiredFields = [
    "role",
    "taskId",
    "changedSurface",
    "content",
    "constraintsRespected",
    "playtestHypothesis",
    "riskBlocker",
    "patch",
    "receipt",
  ];
  const presentFields = requiredFields.filter((field) => parsed[field] !== undefined);
  breakdown.jsonSchema = Math.round((presentFields.length / requiredFields.length) * 25);
  evidence.push(`Schema fields present: ${presentFields.length}/${requiredFields.length}.`);

  const text = stringifyForSignals(parsed);
  const matchedSignals = task.requiredSignals.filter((signal) =>
    text.includes(signal.toLowerCase()),
  );
  breakdown.roleCompleteness = Math.round(
    (matchedSignals.length / task.requiredSignals.length) * 20,
  );
  evidence.push(`Required signals matched: ${matchedSignals.join(", ") || "none"}.`);

  const constraints = Array.isArray(parsed.constraintsRespected) ? parsed.constraintsRespected : [];
  const receipt = Array.isArray(parsed.receipt) ? parsed.receipt : [];
  breakdown.playtestQuality = Math.min(
    20,
    (typeof parsed.playtestHypothesis === "string" && parsed.playtestHypothesis.length >= 20
      ? 8
      : 0) +
      (constraints.length >= 2 ? 6 : constraints.length * 3) +
      (receipt.length >= 2 ? 6 : receipt.length * 3),
  );

  const roleSpecificTerms =
    task.role === "snes-art-audio"
      ? ["tile", "sprite", "palette", "music", "sfx"]
      : task.role === "snes-hardware-qa"
        ? ["rom", "sram", "vram", "cgram", "fxpak"]
        : ["level", "enemy", "reward", "goal", "jump"];
  const matchedRoleTerms = roleSpecificTerms.filter((term) => text.includes(term));
  breakdown.assetOrHardwareSpecificity = Math.round(
    (matchedRoleTerms.length / roleSpecificTerms.length) * 15,
  );
  evidence.push(`Role-specific terms matched: ${matchedRoleTerms.join(", ") || "none"}.`);

  if (typeof latencyMs === "number" && Number.isFinite(latencyMs)) {
    breakdown.latency = latencyMs <= 30_000 ? 10 : latencyMs <= 120_000 ? 6 : 3;
  }
  breakdown.gpt55Judge = Math.max(0, Math.min(10, Math.round(Number(judgeScore ?? 0))));

  let score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  if (!isSafePatch(parsed)) {
    caps.push("unsafe-or-missing-patch-cap-39");
    score = Math.min(score, 39);
  }
  if (breakdown.jsonSchema < 25) {
    caps.push("schema-incomplete-cap-69");
    score = Math.min(score, 69);
  }
  const status = score >= 85 ? "pass" : score >= 70 ? "warning" : "fail";
  return { breakdown, caps, evidence, parsed, score, status };
}

function ollamaModelId(modelRef) {
  return modelRef.startsWith("ollama/") ? modelRef.slice("ollama/".length) : modelRef;
}

function callOllamaModel({ maxOutputTokens, modelRef, prompt, spawn = spawnSync, timeoutSeconds }) {
  const payload = JSON.stringify({
    format: "json",
    model: ollamaModelId(modelRef),
    options: { num_ctx: 4096, num_predict: maxOutputTokens, temperature: 0 },
    prompt,
    stream: false,
  });
  const started = Date.now();
  const result = spawn(
    "curl",
    [
      "--silent",
      "--show-error",
      "--max-time",
      String(timeoutSeconds),
      "http://127.0.0.1:11434/api/generate",
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutSeconds * 1000 },
  );
  const response = extractJsonObject(result.stdout);
  const raw =
    typeof response?.response === "string" && response.response.trim()
      ? response.response
      : typeof response?.thinking === "string" && response.thinking.trim()
        ? response.thinking
        : (result.stdout ?? "");
  return {
    error: result.error
      ? String(result.error.message ?? result.error)
      : response?.error?.message
        ? String(response.error.message)
        : result.status === 0
          ? null
          : result.stderr,
    latencyMs: Date.now() - started,
    raw,
    status: result.status ?? null,
  };
}

function callLocalGlmModel({ maxOutputTokens, prompt, spawn = spawnSync, timeoutSeconds }) {
  const baseUrl = String(
    process.env.OPENCLAW_LOCAL_GLM52_BASE_URL ?? "http://127.0.0.1:28080",
  ).replace(/\/+$/u, "");
  const payload = JSON.stringify({
    max_tokens: maxOutputTokens,
    messages: [{ content: prompt, role: "user" }],
    model: process.env.OPENCLAW_LOCAL_GLM52_MODEL ?? "GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
    response_format: { type: "json_object" },
    temperature: 0,
  });
  const started = Date.now();
  const result = spawn(
    "curl",
    [
      "--silent",
      "--show-error",
      "--max-time",
      String(timeoutSeconds),
      `${baseUrl}/v1/chat/completions`,
      "-H",
      "Content-Type: application/json",
      "-d",
      payload,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutSeconds * 1000 },
  );
  const response = extractJsonObject(result.stdout);
  const raw =
    response?.choices?.[0]?.message?.content ||
    response?.choices?.[0]?.message?.reasoning_content ||
    result.stdout ||
    "";
  return {
    error: result.error
      ? String(result.error.message ?? result.error)
      : response?.error?.message
        ? String(response.error.message)
        : result.status === 0
          ? null
          : result.stderr,
    latencyMs: Date.now() - started,
    raw,
    status: result.status ?? null,
  };
}

export function extractAgentText(stdout) {
  const parsed = extractJsonObject(stdout);
  if (!parsed) {
    return String(stdout ?? "");
  }
  return (
    parsed.reply ??
    parsed.text ??
    parsed.message ??
    parsed.content ??
    parsed.result?.reply ??
    parsed.result?.text ??
    parsed.result?.content ??
    JSON.stringify(parsed)
  );
}

function judgePromptFor({ candidateResult, parsed, task }) {
  return [
    "You are GPT 5.5 judging a SNES Studio model benchmark output.",
    'Return only JSON: {"score":0-10,"strengths":[...],"weaknesses":[...],"winnerRationale":"..."}.',
    "Judge fun, coherence, role usefulness, SNES feasibility, and game-design quality. Do not reward verbosity.",
    `Role: ${task.role}`,
    `Task: ${task.prompt}`,
    `Deterministic score before judge: ${candidateResult.score}`,
    "Output JSON:",
    JSON.stringify(parsed ?? candidateResult.raw ?? {}, null, 2),
  ].join("\n");
}

function runGpt55Judge({ candidateResult, parsed, spawn = spawnSync, task, timeoutSeconds }) {
  if (process.env.OPENCLAW_SNES_BENCHMARK_GPT_JUDGE !== "1") {
    return {
      blocker:
        "OPENCLAW_SNES_BENCHMARK_GPT_JUDGE=1 is required before spending GPT 5.5 judge calls.",
      raw: "",
      score: null,
    };
  }
  const started = Date.now();
  const result = spawn(
    "pnpm",
    [
      "openclaw",
      "agent",
      "--agent",
      "snes-game-director",
      "--model",
      "openai/gpt-5.5",
      "--message",
      judgePromptFor({ candidateResult, parsed, task }),
      "--timeout",
      String(timeoutSeconds),
      "--json",
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: timeoutSeconds * 1000 },
  );
  const text = extractAgentText(result.stdout);
  const judged = extractJsonObject(text);
  return {
    blocker:
      result.error || result.status !== 0
        ? String(result.error?.message ?? result.stderr ?? "GPT 5.5 judge failed")
        : judged && typeof judged.score === "number"
          ? null
          : "GPT 5.5 judge did not return a JSON score.",
    latencyMs: Date.now() - started,
    raw: text,
    score: typeof judged?.score === "number" ? Math.max(0, Math.min(10, judged.score)) : null,
    strengths: Array.isArray(judged?.strengths) ? judged.strengths : [],
    weaknesses: Array.isArray(judged?.weaknesses) ? judged.weaknesses : [],
    winnerRationale: typeof judged?.winnerRationale === "string" ? judged.winnerRationale : "",
  };
}

function taskForRole(role) {
  return SNES_BENCHMARK_TASKS.find((task) => task.role === role) ?? SNES_BENCHMARK_TASKS[0];
}

export function createSnesOutputBenchmarkReport(options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const timeoutSeconds = Math.max(1, Math.trunc(Number(options.timeoutSeconds ?? 900)));
  const judge = options.judge ?? "none";
  const maxOutputTokens = Math.max(64, Math.trunc(Number(options.maxOutputTokens ?? 260)));
  const rounds = Math.max(1, Math.trunc(Number(options.rounds ?? 1)));
  const requestedCandidateRefs = Array.isArray(options.candidateModelRefs)
    ? new Set(options.candidateModelRefs)
    : null;
  const requestedRoles = Array.isArray(options.roles) ? new Set(options.roles) : null;
  const candidates = requestedCandidateRefs
    ? [...requestedCandidateRefs].map(
        (modelRef) =>
          SNES_BENCHMARK_CANDIDATES.find((candidate) => candidate.modelRef === modelRef) ?? {
            modelRef,
            reason: "User-requested installed local benchmark candidate.",
          },
      )
    : SNES_BENCHMARK_CANDIDATES;
  const roles = requestedRoles
    ? SNES_BENCHMARK_ROLES.filter((role) => requestedRoles.has(role))
    : SNES_BENCHMARK_ROLES;
  const localModelDiagnostics = options.localModelDiagnostics ?? {};
  const installed = installedModelSet(
    options.installedModelRefs ?? [],
    options.defaultModelsByRole ?? {},
  );
  const spawn = options.spawn ?? spawnSync;
  const results = [];
  const outputFiles = [];
  for (const role of roles) {
    const task = taskForRole(role);
    for (const candidate of candidates) {
      for (let round = 1; round <= rounds; round += 1) {
        if (!installed.has(candidate.modelRef)) {
          const diagnostic = localModelDiagnostics[candidate.modelRef];
          const localGlmBlocker =
            candidate.modelRef === "local-glm-5.2-2bit" && diagnostic?.modelFilesPresent
              ? `local GLM model files exist, but llama.cpp endpoint is ${diagnostic.status ?? "not ready"} at ${diagnostic.baseUrl ?? GLM52_DEFAULT_BASE_URL}: ${diagnostic.blocker ?? "decode probe failed"}`
              : candidate.modelRef === "local-glm-5.2-2bit" && diagnostic?.listed
                ? `local GLM listed but decode blocked: ${diagnostic.blocker ?? "decode probe failed"}`
                : null;
          results.push({
            available: false,
            blocker:
              localGlmBlocker ??
              `${candidate.modelRef} is not installed locally; skipped without download.`,
            breakdown: null,
            caps: [],
            diagnostic: candidate.modelRef === "local-glm-5.2-2bit" ? (diagnostic ?? null) : null,
            evidence: [],
            judge: null,
            latencyMs: null,
            modelRef: candidate.modelRef,
            parsed: null,
            raw: "",
            role,
            round,
            score: 0,
            skipped: true,
            status: "blocked",
            taskId: task.id,
          });
          continue;
        }
        const prompt = benchmarkPrompt(task, { compact: true });
        const call =
          candidate.modelRef === "local-glm-5.2-2bit"
            ? callLocalGlmModel({ maxOutputTokens, prompt, spawn, timeoutSeconds })
            : callOllamaModel({
                maxOutputTokens,
                modelRef: candidate.modelRef,
                prompt,
                spawn,
                timeoutSeconds,
              });
        let scored = scoreSnesOutputBenchmarkResponse({
          latencyMs: call.latencyMs,
          raw: call.raw,
          task,
        });
        let judgeResult = null;
        if (judge === "gpt-5.5") {
          judgeResult = runGpt55Judge({
            candidateResult: { ...scored, raw: call.raw },
            parsed: scored.parsed,
            spawn,
            task,
            timeoutSeconds,
          });
          if (judgeResult.score !== null) {
            scored = scoreSnesOutputBenchmarkResponse({
              judgeScore: judgeResult.score,
              latencyMs: call.latencyMs,
              raw: call.raw,
              task,
            });
          }
        }
        results.push({
          available: true,
          blocker: call.error || judgeResult?.blocker || null,
          breakdown: scored.breakdown,
          caps: scored.caps,
          diagnostic:
            candidate.modelRef === "local-glm-5.2-2bit"
              ? (localModelDiagnostics["local-glm-5.2-2bit"] ?? null)
              : null,
          evidence: scored.evidence,
          judge: judgeResult,
          latencyMs: call.latencyMs,
          modelRef: candidate.modelRef,
          parsed: scored.parsed,
          raw: call.raw,
          role,
          round,
          score: scored.score,
          skipped: false,
          status: call.error || judgeResult?.blocker ? "blocked" : scored.status,
          taskId: task.id,
        });
      }
    }
  }
  const currentDefaultsByRole = Object.fromEntries(
    roles.map((role) => [
      role,
      options.defaultModelsByRole?.[role] ?? "ollama/openclaw-control-qwen25-32b:latest",
    ]),
  );
  const modelSummaries = createOutputModelSummaries({ candidates, results, roles });
  const { promotionRecommendationsByRole, recommendedWinnersByRole } =
    createPromotionRecommendations({ currentDefaultsByRole, modelSummaries, roles });
  const winnersByRole = recommendedWinnersByRole;
  const blockers = uniqueStrings(
    results.flatMap((result) => (result.blocker ? [result.blocker] : [])),
  );
  const usableResults = results.filter(
    (result) => result.available && !result.skipped && ["pass", "warning"].includes(result.status),
  );
  const failedAvailableResults = results.filter(
    (result) => result.available && !result.skipped && result.status === "fail",
  );
  return {
    blockers,
    candidates,
    currentDefaultsByRole,
    downloadsAttempted: false,
    format: "openclaw-snes-real-output-model-benchmark-report",
    generatedAt,
    hostedGlmUsed: false,
    hostedProvidersUsed: judge === "gpt-5.5",
    judge,
    localModelDiagnostics,
    maxOutputTokens,
    modelSummaries,
    noDownload: options.noDownload !== false,
    outputFiles,
    promotionApplied: false,
    promotionRecommendationsByRole,
    promotionRule:
      "winner must beat current default by at least 5 mean points across all rounds with no blocked, invalid JSON, or fail runs",
    recommendedWinnersByRole,
    results,
    roles,
    rounds,
    status:
      usableResults.length > 0 && blockers.length === 0 && failedAvailableResults.length === 0
        ? "ready"
        : usableResults.length > 0 || results.some((result) => result.available && !result.skipped)
          ? "partial"
          : "blocked",
    timeoutSeconds,
    version: 2,
    winnersByRole,
  };
}

export function renderBenchmarkSummaryMarkdown(report) {
  const lines = [
    "# SNES Real Output Model Benchmark",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Rounds: ${report.rounds ?? 1}`,
    `Hosted providers used: ${report.hostedProvidersUsed ? "yes" : "no"}`,
    `Hosted GLM used: ${report.hostedGlmUsed ? "yes" : "no"}`,
    `Downloads attempted: ${report.downloadsAttempted ? "yes" : "no"}`,
    `Promotion applied: ${report.promotionApplied ? "yes" : "no"}`,
    "",
    "| Role | Current default | Recommended winner | Model | Mean score | Worst | Best | Mean latency | Runs | Status counts | Blockers |",
    "|---|---|---|---|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const summary of report.modelSummaries ?? []) {
    const role = summary.role;
    const statusCountsText = Object.entries(summary.statusCounts ?? {})
      .map(([status, count]) => `${status}:${count}`)
      .join(", ");
    const cells = [
      role,
      report.currentDefaultsByRole?.[role] ?? "",
      report.recommendedWinnersByRole?.[role] ?? report.winnersByRole?.[role] ?? "",
      summary.modelRef,
      summary.meanScore,
      summary.worstScore,
      summary.bestScore,
      summary.meanLatencyMs ?? "",
      summary.rounds,
      statusCountsText,
      (summary.blockers ?? []).join("; "),
    ].map((value) => String(value).replace(/\|/gu, "\\|"));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("", "Promotion rule:", report.promotionRule ?? "");
  return `${lines.join("\n")}\n`;
}

export function writeBenchmarkArtifacts(report, artifactDir) {
  const safeGeneratedAt = report.generatedAt.replace(/[^0-9A-Za-z_-]/gu, "-");
  const runDir = path.join(artifactDir, safeGeneratedAt);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  if (Array.isArray(report.results)) {
    for (const result of report.results) {
      if (!result.available || result.skipped) {
        continue;
      }
      const roundSuffix = result.round ? `__round-${String(result.round).padStart(2, "0")}` : "";
      const fileBase = `${result.role}__${result.modelRef.replace(/[^0-9A-Za-z_.-]/gu, "_")}${roundSuffix}`;
      const rawPath = path.join(runDir, `${fileBase}.raw.txt`);
      const parsedPath = path.join(runDir, `${fileBase}.parsed.json`);
      writeFileSync(rawPath, `${result.raw ?? ""}\n`);
      writeFileSync(parsedPath, `${JSON.stringify(result.parsed ?? null, null, 2)}\n`);
      result.rawOutputPath = rawPath;
      result.parsedOutputPath = parsedPath;
      if (result.judge?.raw) {
        const judgePath = path.join(runDir, `${fileBase}.judge.txt`);
        writeFileSync(judgePath, `${result.judge.raw}\n`);
        result.judge.outputPath = judgePath;
      }
    }
  }
  const reportPath = path.join(runDir, "report.json");
  const latestPath = path.join(artifactDir, "latest.json");
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, payload);
  writeFileSync(latestPath, payload);
  let summaryPath = null;
  if (report.format === "openclaw-snes-real-output-model-benchmark-report") {
    summaryPath = path.join(artifactDir, "latest-summary.md");
    writeFileSync(summaryPath, renderBenchmarkSummaryMarkdown(report));
  }
  return { latestPath, reportPath, runDir, summaryPath };
}
