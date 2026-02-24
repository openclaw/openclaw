const MC_TASK_RE = /\btask(?:[_ -]?id)?\s*[:=]\s*([A-Za-z0-9_-]+)/i;
const MC_TASK_LINK_RE = /https?:\/\/\S+\/tasks\/([A-Za-z0-9_-]+)/i;
const NON_TRIVIAL_RE =
  /\b(code changes?|file writes?|deploy(?:ment)?|multi-step|checkpoint plan|closure packet|blocked packet|running tests?|\bbuild\b|executing now|i['’]ll do this now|implement|patch|commit|pr\b)\b/i;
const GEC_LEGAL_END_STATES = ["CLOSURE PACKET", "BLOCKED PACKET", "CHECKPOINT PLAN"];

const hasGecLegalEndState = (text) =>
  GEC_LEGAL_END_STATES.some((t) => text.toUpperCase().includes(t));
const isNonTrivialExecution = (text) => NON_TRIVIAL_RE.test(text);
const extractTaskIdFromText = (text) =>
  MC_TASK_RE.exec(text)?.[1] || MC_TASK_LINK_RE.exec(text)?.[1];
const normalizeMcBaseUrl = () => "https://mission-control.local";
const chooseDefaultOwnerAgent = (text) =>
  /\b(product|spec|priorit|roadmap|acceptance criteria)\b/i.test(text)
    ? "ava-product-manager"
    : "cb-router";
const ensureMcLinkOnPacket = (text, link) =>
  !link || !hasGecLegalEndState(text) || text.startsWith("MC Task:")
    ? text
    : `MC Task: ${link}\n${text}`;
const buildBlockedPacket = (reason) =>
  `BLOCKED PACKET\nMissing requirement: ${reason}\nRequired next step: restore Mission Control connectivity/credentials and retry.`;

async function ensureMissionControlBinding({ text, taskId, taskLink, agentId, client }) {
  const raw = (text ?? "").trim();
  if (!raw || !isNonTrivialExecution(raw)) {
    return { proceed: true, text: raw, taskId, taskLink };
  }
  let resolvedTaskId = taskId || extractTaskIdFromText(raw);
  let resolvedTaskLink = taskLink;
  if (!resolvedTaskId) {
    try {
      const created = await client.createTask({
        title: raw.slice(0, 120),
        type: /\bdeploy|infra|ops\b/i.test(raw) ? "CHORE" : "STORY",
        ownerAgent: chooseDefaultOwnerAgent(raw),
        nextAction: "Execute one bounded checkpoint and report proof.",
        status: "backlog",
      });
      resolvedTaskId = created.taskId;
      resolvedTaskLink = created.link;
      const checkpoint = `CHECKPOINT PLAN\n1) Task created: ${resolvedTaskLink}\n2) Acquire ACTIVE lease for executor agent. Proof: lease ACTIVE for ${agentId}.\n3) Execute exactly one bounded step and report evidence linked to task ${resolvedTaskId}.`;
      return {
        proceed: false,
        createdTask: true,
        text: ensureMcLinkOnPacket(checkpoint, resolvedTaskLink),
        taskId: resolvedTaskId,
        taskLink: resolvedTaskLink,
      };
    } catch (err) {
      return { proceed: false, text: buildBlockedPacket(String(err)), blockedReason: String(err) };
    }
  }
  if (!resolvedTaskLink) {
    resolvedTaskLink = `${normalizeMcBaseUrl()}/tasks/${resolvedTaskId}`;
  }
  try {
    const lease = await client.ensureLeaseActive({ taskId: resolvedTaskId, agentId });
    if (!lease.active) {
      return {
        proceed: false,
        text: buildBlockedPacket("MC lease is not ACTIVE"),
        taskId: resolvedTaskId,
        taskLink: resolvedTaskLink,
        blockedReason: "MC lease is not ACTIVE",
      };
    }
  } catch (err) {
    return {
      proceed: false,
      text: buildBlockedPacket(String(err)),
      taskId: resolvedTaskId,
      taskLink: resolvedTaskLink,
      blockedReason: String(err),
    };
  }
  return {
    proceed: true,
    text: ensureMcLinkOnPacket(raw, resolvedTaskLink),
    taskId: resolvedTaskId,
    taskLink: resolvedTaskLink,
  };
}

const okClient = {
  async createTask() {
    return { taskId: "TASK-101", link: "https://mission-control.local/tasks/TASK-101" };
  },
  async ensureLeaseActive() {
    return { active: true };
  },
};
const downClient = {
  async createTask() {
    throw new Error("MC connectivity / credentials missing (MC_API_URL or MC_API_TOKEN)");
  },
  async ensureLeaseActive() {
    throw new Error("MC connectivity / credentials missing (MC_API_URL or MC_API_TOKEN)");
  },
};

console.log("CASE=a_no_taskid_autocreate");
console.log(
  JSON.stringify(
    await ensureMissionControlBinding({
      text: "Implement code changes and run build",
      agentId: "cb-router",
      client: okClient,
    }),
    null,
    2,
  ),
);

console.log("CASE=b_mc_unreachable_blocked");
console.log(
  JSON.stringify(
    await ensureMissionControlBinding({
      text: "Deploy patch and run tests",
      agentId: "cb-router",
      client: downClient,
    }),
    null,
    2,
  ),
);

console.log("CASE=c_existing_taskid_proceeds");
console.log(
  JSON.stringify(
    await ensureMissionControlBinding({
      text: "CLOSURE PACKET\nDone. taskId: TASK-555",
      agentId: "cb-router",
      client: okClient,
    }),
    null,
    2,
  ),
);
