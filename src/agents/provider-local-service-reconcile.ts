export type ProviderLocalServiceReconcileContext = {
  baseUrl: string;
  signal?: AbortSignal;
};

export type ProviderLocalServiceReconciler = (
  ctx: ProviderLocalServiceReconcileContext,
) => Promise<void>;

const MODEL_PROVIDER_LOCAL_SERVICE_RECONCILER_SYMBOL = Symbol.for(
  "openclaw.modelProviderLocalServiceReconciler",
);

type ModelWithProviderLocalServiceReconciler = {
  [MODEL_PROVIDER_LOCAL_SERVICE_RECONCILER_SYMBOL]?: ProviderLocalServiceReconciler;
};

/** Carry the prepared provider's reconcile hook through the model transport boundary. */
export function attachModelProviderLocalServiceReconciler<TModel extends object>(
  model: TModel,
  reconcile: ProviderLocalServiceReconciler | undefined,
): TModel {
  const descriptors = Object.getOwnPropertyDescriptors(model);
  Reflect.deleteProperty(descriptors, MODEL_PROVIDER_LOCAL_SERVICE_RECONCILER_SYMBOL);
  return Object.defineProperties(
    { ...model, [MODEL_PROVIDER_LOCAL_SERVICE_RECONCILER_SYMBOL]: reconcile },
    descriptors,
  );
}

export function getModelProviderLocalServiceReconciler(
  model: object,
): ProviderLocalServiceReconciler | undefined {
  // SAFETY: only the attach helper writes this optional symbol; absent carriers read as undefined.
  return (model as ModelWithProviderLocalServiceReconciler)[
    MODEL_PROVIDER_LOCAL_SERVICE_RECONCILER_SYMBOL
  ];
}
