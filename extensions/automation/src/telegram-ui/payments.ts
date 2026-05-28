export async function createSubscriptionInvoice(botToken: string): Promise<string> {
  if (!botToken.trim()) {
    throw new Error("telegram bot token is required");
  }
  const res = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "SuperClaw Pro",
      description: "解鎖全部功能：多智能體協作、流程視覺編輯、維運整合、優先執行",
      payload: "superclaw-pro-monthly",
      currency: "XTR",
      prices: [{ label: "每月專業版", amount: 100 }],
      subscription_period: 2592000,
    }),
  });
  if (!res.ok) {
    throw new Error(`telegram invoice request failed: ${res.status}`);
  }
  let data: { ok?: boolean; result?: unknown; description?: string };
  try {
    data = (await res.json()) as { ok?: boolean; result?: unknown; description?: string };
  } catch {
    throw new Error("telegram invoice response is not valid json");
  }
  if (!data.ok || typeof data.result !== "string" || data.result.length === 0) {
    const reason = data.description ?? "unknown";
    throw new Error(`telegram invoice creation failed: ${reason}`);
  }
  return data.result;
}

export type ProFeatures = {
  multiAgent: boolean;
  workflowEditor: boolean;
  devOpsIntegration: boolean;
  priorityExecution: boolean;
  customWorkflows: boolean;
  unlimitedCron: boolean;
};

export function getProFeatures(isPro: boolean): ProFeatures {
  if (isPro) {
    return {
      multiAgent: true,
      workflowEditor: true,
      devOpsIntegration: true,
      priorityExecution: true,
      customWorkflows: true,
      unlimitedCron: true,
    };
  }
  return {
    multiAgent: false,
    workflowEditor: false,
    devOpsIntegration: false,
    priorityExecution: false,
    customWorkflows: false,
    unlimitedCron: false,
  };
}
