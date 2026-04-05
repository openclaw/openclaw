import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
  resolveDefaultModelForAgent,
} from "mullusi/plugin-sdk/agent-runtime";
import type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";

export async function resolveStickerVisionSupportRuntime(params: {
  cfg: MullusiConfig;
  agentId?: string;
}): Promise<boolean> {
  const catalog = await loadModelCatalog({ config: params.cfg });
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
  if (!entry) {
    return false;
  }
  return modelSupportsVision(entry);
}
