import fs from "node:fs/promises";
import path from "node:path";

export const SLACK_ARTIFACT_TEST_CHANNEL = "C123456789";

export async function writeApprovalCheckpointArtifacts(
  outputDir: string,
  scenarioIds: readonly string[],
  omitCheckpoint?: string,
) {
  const checkpointDir = path.join(outputDir, "approval-checkpoints");
  await fs.mkdir(checkpointDir, { recursive: true });
  for (const [index, scenarioId] of scenarioIds.entries()) {
    for (const state of ["pending", "resolved"] as const) {
      if (omitCheckpoint !== `${scenarioId}.${state}.json`) {
        await fs.writeFile(
          path.join(checkpointDir, `${scenarioId}.${state}.json`),
          `${JSON.stringify({
            version: 1,
            scenarioId,
            approvalKind: scenarioId === "slack-approval-exec-native" ? "exec" : "plugin",
            state,
            approvalId: `${scenarioId}:approval`,
            channelId: SLACK_ARTIFACT_TEST_CHANNEL,
            messageTs: `${index + 1}.000000`,
            threadTs: null,
            decision: state === "resolved" ? "allow-once" : null,
            observedAt: "2026-05-04T13:00:29.000Z",
            message: {
              actionLabels: state === "pending" ? ["Allow Once", "Allow Always", "Deny"] : [],
              blockText:
                state === "pending"
                  ? ["Plugin approval required", "Slack plugin approval QA marker"]
                  : ["Plugin approval: Allowed once", "Slack plugin approval QA marker"],
              hasNativeActions: state === "pending",
              text:
                state === "pending" ? "Plugin approval required" : "Plugin approval: Allowed once",
            },
          })}\n`,
        );
      }
      await fs.writeFile(
        path.join(checkpointDir, `${scenarioId}.${state}.ack.json`),
        `${JSON.stringify({
          version: 1,
          capturedAt: "2026-05-04T13:00:30.000Z",
          scenarioId,
          screenshotPath: `${checkpointDir}/${scenarioId}-${state}.png`,
          state,
        })}\n`,
      );
      await fs.writeFile(path.join(checkpointDir, `${scenarioId}-${state}.png`), "png");
    }
  }
}
