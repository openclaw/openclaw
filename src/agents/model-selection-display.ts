type ModelDisplaySelectionParams = {
  runtimeProvider?: string | null;
  runtimeModel?: string | null;
  overrideProvider?: string | null;
  overrideModel?: string | null;
  fallbackModel?: string | null;
};

export function resolveModelDisplayRef(params: ModelDisplaySelectionParams): string | undefined {
  const runtimeModel = params.runtimeModel?.trim();
  const runtimeProvider = params.runtimeProvider?.trim();
  if (runtimeModel) {
    if (runtimeModel.includes("/")) {
      return runtimeModel;
    }
    if (runtimeProvider) {
      return `${runtimeProvider}/${runtimeModel}`;
    }
    return runtimeModel;
  }
  if (runtimeProvider) {
    return runtimeProvider;
  }

  const overrideModel = params.overrideModel?.trim();
  const overrideProvider = params.overrideProvider?.trim();
  if (overrideModel) {
    if (overrideModel.includes("/")) {
      return overrideModel;
    }
    if (overrideProvider) {
      return `${overrideProvider}/${overrideModel}`;
    }
    return overrideModel;
  }
  if (overrideProvider) {
    return overrideProvider;
  }

  const fallbackModel = params.fallbackModel?.trim();
  return fallbackModel || undefined;
}

export function resolveModelDisplayName(params: ModelDisplaySelectionParams): string {
  const modelRef = resolveModelDisplayRef(params);
  if (!modelRef) {
    return "model n/a";
  }
  const slash = modelRef.lastIndexOf("/");
  if (slash >= 0 && slash < modelRef.length - 1) {
    return modelRef.slice(slash + 1);
  }
  return modelRef;
}

type SessionInfoModelSelectionParams = {
  currentProvider?: string | null;
  currentModel?: string | null;
  entryProvider?: string | null;
  entryModel?: string | null;
  overrideProvider?: string | null;
  overrideModel?: string | null;
};

export function resolveSessionInfoModelSelection(params: SessionInfoModelSelectionParams): {
  modelProvider?: string;
  model?: string;
} {
  if (params.entryProvider !== undefined || params.entryModel !== undefined) {
    return {
      modelProvider: params.entryProvider ?? params.currentProvider ?? undefined,
      model: params.entryModel ?? params.currentModel ?? undefined,
    };
  }

  const overrideModel = params.overrideModel?.trim();
  if (overrideModel) {
    const overrideProvider = params.overrideProvider?.trim();
    const currentProvider = params.currentProvider ?? undefined;
    return {
      modelProvider: overrideProvider || currentProvider,
      model: overrideModel,
    };
  }

  return {
    modelProvider: params.currentProvider ?? undefined,
    model: params.currentModel ?? undefined,
  };
}
