import type { InteractiveReply } from "./types.js";
import { buildBreadcrumb } from "./main-menu.js";

export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  isCurrent?: boolean;
};

export function buildModelPanel(
  models: ModelInfo[],
  currentModel?: string,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "模型切換");

  const currentLine = currentModel
    ? `當前: <code>${currentModel}</code>\n`
    : "";

  const grouped = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = grouped.get(m.provider) ?? [];
    list.push(m);
    grouped.set(m.provider, list);
  }

  const blocks: InteractiveReply["blocks"] = [
    {
      type: "text",
      text: `${nav}\n\n🧠 <b>模型選擇</b>\n\n${currentLine}`,
    },
  ];

  for (const [_provider, providerModels] of grouped) {
    const buttons = providerModels.slice(0, 3).map((m) => ({
      label: `${m.isCurrent ? "✅ " : ""}${m.name}`,
      value: `sc:md:sw:${m.id}`,
      style: (m.isCurrent ? "success" : "primary") as "success" | "primary",
    }));
    blocks.push({ type: "buttons", buttons });
  }

  blocks.push({
    type: "buttons",
    buttons: [{ label: "← 首頁", value: "sc:home", style: "primary" }],
  });

  return { blocks };
}

export function buildModelSwitchResult(
  modelName: string,
  success: boolean,
): InteractiveReply {
  return {
    blocks: [
      {
        type: "text",
        text: success
          ? `✅ 已切換至 <b>${modelName}</b>`
          : `❌ 切換至 ${modelName} 失敗`,
      },
      {
        type: "buttons",
        buttons: [
          { label: "🧠 模型列表", value: "sc:model", style: "primary" },
          { label: "← 首頁", value: "sc:home", style: "primary" },
        ],
      },
    ],
  };
}
