type TelegramIngressPreparation = () => Promise<boolean>;

type PreparationScope = {
  prepare: TelegramIngressPreparation;
  consumed: boolean;
};

// Native middleware owns sender admission. The transport only binds a preparer
// to this exact update; it cannot run until that middleware consumes it.
const preparations = new WeakMap<object, PreparationScope>();

export async function runWithTelegramIngressPreparation<T>(
  update: unknown,
  prepare: TelegramIngressPreparation,
  dispatch: () => Promise<T>,
): Promise<T> {
  if (typeof update !== "object" || update === null) {
    return await dispatch();
  }
  if (preparations.has(update)) {
    throw new Error("Telegram ingress preparation is already bound to this update");
  }
  const scope = { prepare, consumed: false };
  preparations.set(update, scope);
  try {
    return await dispatch();
  } finally {
    preparations.delete(update);
  }
}

/**
 * Prepares ordinary noncommand singletons only after native admission and,
 * for fresh messages, dispatch deduplication. Commands and albums retain native owners.
 */
export async function prepareTelegramAuthorizedIngress(update: object): Promise<boolean> {
  const scope = preparations.get(update);
  if (!scope || scope.consumed) {
    return false;
  }
  scope.consumed = true;
  return await scope.prepare();
}
