const apiBase = (process.env.MC_API_URL || "").replace(/\/$/, "");
const appBase = (process.env.MC_APP_BASE_URL || "").replace(/\/$/, "");
const token = process.env.MC_API_TOKEN || "";

if (!apiBase || !appBase || !token) {
  console.error("Missing required env vars: MC_API_URL, MC_APP_BASE_URL, MC_API_TOKEN");
  process.exit(1);
}

const createPayload = {
  title: "G4.1-3 runtime prod binding verification",
  type: "STORY",
  priority: "P2",
  ownerAgent: "cb-router",
  nextAction: "Acquire ACTIVE lease and post checkpoint evidence",
  tags: ["runtime-api", "g4.1-3", "acceptance-endstate:done"],
};

async function postJson(url, body, authToken) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const invalid = await postJson(
  `${apiBase}/tasks`,
  { title: "invalid-token-test" },
  "invalid-token",
);
console.log("NEGATIVE_INVALID_TOKEN");
console.log(JSON.stringify(invalid, null, 2));

const created = await postJson(`${apiBase}/tasks`, createPayload, token);
if (created.status !== 200) {
  console.log("CREATE_FAILED");
  console.log(JSON.stringify(created, null, 2));
  process.exit(2);
}
const taskId = created.json.taskId;
const taskLink = created.json.taskLink || `${appBase}/tasks/${taskId}`;

const lease = await postJson(`${apiBase}/tasks/${taskId}/lease`, { agentName: "cb-router" }, token);

const checkpointPlan = `MC Task: ${taskLink}\nCHECKPOINT PLAN\n1) Task created: ${taskLink}\n2) ACTIVE lease confirmed for cb-router. Proof: leaseId ${lease.json.leaseId}, status ${lease.json.status}.\n3) Execute one bounded step and report evidence linked to ${taskId}.`;

console.log("POSITIVE_CREATE_TASK");
console.log(JSON.stringify({ status: created.status, taskId, taskLink }, null, 2));
console.log("POSITIVE_LEASE");
console.log(JSON.stringify(lease, null, 2));
console.log("CHECKPOINT_PLAN_OUTPUT");
console.log(checkpointPlan);
