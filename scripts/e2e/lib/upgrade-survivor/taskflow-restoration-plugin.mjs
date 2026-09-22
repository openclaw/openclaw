import {
  TASKFLOW_FLOW_IDS,
  TASKFLOW_METHOD,
  TASKFLOW_OWNER,
  TASKFLOW_PLUGIN_ID,
  TASKFLOW_TASK_IDS,
} from "./taskflow-restoration-fixture.mjs";

export default {
  id: TASKFLOW_PLUGIN_ID,
  register(api) {
    // Registration is inert on the published baseline; only the candidate is queried.
    api.registerGatewayMethod(
      TASKFLOW_METHOD,
      async ({ respond }) => {
        const tasks = api.runtime.tasks.async;
        const binding = { sessionKey: TASKFLOW_OWNER, agentId: "main" };
        const runs = tasks.runs.bindSession(binding);
        const flows = tasks.flows.bindSession(binding);
        const managed = tasks.managedFlows.bindSession(binding);
        const timings = [];
        const read = async (name, operation) => {
          const started = performance.now();
          try {
            return await operation();
          } finally {
            timings.push({ name, elapsedMs: performance.now() - started });
          }
        };
        const runDetails = [];
        const resolvedRuns = [];
        for (const [index, id] of TASKFLOW_TASK_IDS.entries()) {
          runDetails.push(await read(`runs.get:${id}`, () => runs.get(id)));
          resolvedRuns.push(
            await read(`runs.resolve:${id}`, () => runs.resolve(`update-cell-run-0${index + 1}`)),
          );
        }
        const flowDetails = [];
        const flowSummaries = [];
        for (const id of TASKFLOW_FLOW_IDS) {
          flowDetails.push(await read(`flows.get:${id}`, () => flows.get(id)));
          flowSummaries.push(
            await read(`flows.getTaskSummary:${id}`, () => flows.getTaskSummary(id)),
          );
        }
        respond(true, {
          ownerKey: TASKFLOW_OWNER,
          runtimeVersion: api.runtime.version,
          stateDir: process.env.OPENCLAW_STATE_DIR,
          runs: await read("runs.list", () => runs.list()),
          runDetails,
          resolvedRuns,
          flows: await read("flows.list", () => flows.list()),
          flowDetails,
          flowSummaries,
          managedFlow: await read("managedFlows.get", () => managed.get(TASKFLOW_FLOW_IDS[0])),
          timings,
        });
      },
      { scope: "operator.admin" },
    );
  },
};
