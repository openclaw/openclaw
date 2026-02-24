const NON_TRIVIAL_RE =
  /\b(code changes?|file writes?|deploy(?:ment)?|multi-step|checkpoint plan|closure packet|blocked packet|running tests?|\bbuild\b|executing now|i['’]ll do this now|implement|patch|commit|pr\b)\b/i;
const MC_TASK_RE = /\btask(?:[_ -]?id)?\s*[:=]\s*([A-Za-z0-9_-]+)/i;
const MC_TASK_LINK_RE = /https?:\/\/\S+\/tasks\/([A-Za-z0-9_-]+)/i;

const isNonTrivialExecution = (text) => NON_TRIVIAL_RE.test(text);
const extractTaskIdFromText = (text) =>
  MC_TASK_RE.exec(text)?.[1] || MC_TASK_LINK_RE.exec(text)?.[1];
const deriveAppBaseFromApiUrl = (apiUrl) => apiUrl.replace(/\/$/, "").replace(/\/api$/i, "");
const resolveMcBaseUrl = (env) => {
  if (env.MC_APP_BASE_URL?.trim()) {
    return env.MC_APP_BASE_URL.trim().replace(/\/$/, "");
  }
  if (!env.MC_API_URL?.trim()) {
    return null;
  }
  return deriveAppBaseFromApiUrl(env.MC_API_URL.trim());
};
const missingMcVars = (env) => {
  const m = [];
  if (!env.MC_API_URL?.trim()) {
    m.push("MC_API_URL");
  }
  if (!env.MC_API_TOKEN?.trim()) {
    m.push("MC_API_TOKEN");
  }
  return m;
};
const buildBlockedPacket = (reason) =>
  `BLOCKED PACKET\nMissing requirement: ${reason}\nRequired next step: set required Mission Control env vars and retry.`;

async function ensureMissionControlBinding({ text, env, client }) {
  const raw = (text ?? "").trim();
  if (!raw || !isNonTrivialExecution(raw)) {
    return { proceed: true, text: raw };
  }
  let taskId = extractTaskIdFromText(raw);
  let taskLink;
  if (!taskId) {
    const missing = missingMcVars(env);
    if (missing.length > 0) {
      return {
        proceed: false,
        text: buildBlockedPacket(`Missing required vars: ${missing.join(", ")}`),
      };
    }
    const created = await client.createTask();
    taskId = created.taskId;
    taskLink = created.link || `${resolveMcBaseUrl(env)}/tasks/${taskId}`;
    return {
      proceed: false,
      taskId,
      taskLink,
      text: `MC Task: ${taskLink}\nCHECKPOINT PLAN\n1) Task created: ${taskLink}\n2) Acquire ACTIVE lease for executor agent. Proof: lease ACTIVE.\n3) Execute one bounded step and post evidence for ${taskId}.`,
    };
  }
  taskLink = `${resolveMcBaseUrl(env)}/tasks/${taskId}`;
  return {
    proceed: true,
    taskId,
    taskLink,
    text: `MC Task: ${taskLink}\nCLOSURE PACKET\nTask continues.`,
  };
}

const fakeClient = {
  async createTask() {
    return { taskId: "TASK-900", link: null };
  },
};

console.log("CASE=a_missing_env_blocked");
console.log(
  JSON.stringify(
    await ensureMissionControlBinding({
      text: "Implement code changes and run build",
      env: { MC_API_URL: "", MC_API_TOKEN: "" },
      client: fakeClient,
    }),
    null,
    2,
  ),
);

console.log("CASE=b_env_present_checkpoint_with_derived_link");
console.log(
  JSON.stringify(
    await ensureMissionControlBinding({
      text: "Implement code changes and run build",
      env: {
        MC_API_URL: "https://mission-control-mocha-tau.vercel.app/api",
        MC_API_TOKEN: "present",
      },
      client: fakeClient,
    }),
    null,
    2,
  ),
);
