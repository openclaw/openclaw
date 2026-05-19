export async function createSubscriptionInvoice(botToken: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "SuperClaw Pro",
      description:
        "解鎖全部功能：多 Agent 協作、Workflow 視覺編輯、DevOps 整合、優先執行",
      payload: "superclaw-pro-monthly",
      currency: "XTR",
      prices: [{ label: "Monthly Pro", amount: 100 }],
      subscription_period: 2592000,
    }),
  });
  const data = await res.json();
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
