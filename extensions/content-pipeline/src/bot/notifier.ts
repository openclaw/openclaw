/**
 * Zalo OA message sender for pipeline notifications.
 */

const ZALO_API = "https://openapi.zalo.me/v2.0/oa/message/text";

export async function sendMessage(
  userId: string,
  text: string,
  accessToken: string,
): Promise<void> {
  const resp = await fetch(ZALO_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: { user_id: userId },
      message: { text },
    }),
  });

  if (!resp.ok) {
    console.error(`Zalo notify failed: ${resp.status} ${await resp.text()}`);
  }
}

export function createNotifier(accessToken: string, userId: string) {
  const notify = (text: string) => sendMessage(userId, text, accessToken);

  return {
    start: (pipelineType: string, runId: string) =>
      notify(`🚀 Pipeline started: ${pipelineType}\nRun: ${runId}`),

    stage: (stageIndex: number, totalStages: number, stageName: string) =>
      notify(`📦 Stage ${stageIndex}/${totalStages}: ${stageName}...`),

    done: (runId: string, results: Array<{ platform: string; url?: string; status: string }>) => {
      const lines = results.map((r) => {
        if (r.status === "success" && r.url) return `  ✅ ${r.platform}: ${r.url}`;
        if (r.status === "success") return `  ✅ ${r.platform}: uploaded`;
        return `  ❌ ${r.platform}: ${r.status}`;
      });
      return notify(`✅ Pipeline complete!\n${lines.join("\n")}`);
    },

    error: (runId: string, stage: string, error: string) =>
      notify(`❌ Pipeline error\nRun: ${runId}\nStage: ${stage}\nError: ${error}`),
  };
}
