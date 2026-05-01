type PayloadPatchLogger = {
  warn(message: string): void;
};

export type OpenAICompletionsPayloadPatch = (payload: Record<string, unknown>) => void;

function sanitizeExtraParamsRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "__proto__" && key !== "prototype" && key !== "constructor",
    ),
  );
}

function sanitizeExtraBodyRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(sanitizeExtraParamsRecord(value) ?? {}).filter(
      ([, entry]) => entry !== undefined,
    ),
  );
}

function resolveAliasedParamValue(
  sources: Array<Record<string, unknown> | undefined>,
  snakeCaseKey: string,
  camelCaseKey: string,
): unknown {
  let resolved: unknown = undefined;
  let seen = false;
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const hasSnakeCaseKey = Object.hasOwn(source, snakeCaseKey);
    const hasCamelCaseKey = Object.hasOwn(source, camelCaseKey);
    if (!hasSnakeCaseKey && !hasCamelCaseKey) {
      continue;
    }
    resolved = hasSnakeCaseKey ? source[snakeCaseKey] : source[camelCaseKey];
    seen = true;
  }
  return seen ? resolved : undefined;
}

function resolveExtraBodyParam(
  rawExtraBody: unknown,
  logger?: PayloadPatchLogger,
): Record<string, unknown> | undefined {
  if (rawExtraBody === undefined || rawExtraBody === null) {
    return undefined;
  }
  if (typeof rawExtraBody !== "object" || Array.isArray(rawExtraBody)) {
    const summary = typeof rawExtraBody === "string" ? rawExtraBody : typeof rawExtraBody;
    logger?.warn(`ignoring invalid extra_body param: ${summary}`);
    return undefined;
  }
  const extraBody = sanitizeExtraBodyRecord(rawExtraBody as Record<string, unknown>);
  return Object.keys(extraBody).length > 0 ? extraBody : undefined;
}

function resolveChatTemplateKwargsParam(
  rawChatTemplateKwargs: unknown,
  logger?: PayloadPatchLogger,
): Record<string, unknown> | undefined {
  if (rawChatTemplateKwargs === undefined || rawChatTemplateKwargs === null) {
    return undefined;
  }
  if (typeof rawChatTemplateKwargs !== "object" || Array.isArray(rawChatTemplateKwargs)) {
    const summary =
      typeof rawChatTemplateKwargs === "string"
        ? rawChatTemplateKwargs
        : typeof rawChatTemplateKwargs;
    logger?.warn(`ignoring invalid chat_template_kwargs param: ${summary}`);
    return undefined;
  }
  const chatTemplateKwargs = sanitizeExtraBodyRecord(
    rawChatTemplateKwargs as Record<string, unknown>,
  );
  return Object.keys(chatTemplateKwargs).length > 0 ? chatTemplateKwargs : undefined;
}

export function createOpenAICompletionsExtraParamsPayloadPatch(params: {
  sources: Array<Record<string, unknown> | undefined>;
  logger?: PayloadPatchLogger;
}): OpenAICompletionsPayloadPatch | undefined {
  const rawChatTemplateKwargs = resolveAliasedParamValue(
    params.sources,
    "chat_template_kwargs",
    "chatTemplateKwargs",
  );
  const configuredChatTemplateKwargs = resolveChatTemplateKwargsParam(
    rawChatTemplateKwargs,
    params.logger,
  );
  const rawExtraBody = resolveAliasedParamValue(params.sources, "extra_body", "extraBody");
  const extraBody = resolveExtraBodyParam(rawExtraBody, params.logger);
  if (!configuredChatTemplateKwargs && !extraBody) {
    return undefined;
  }

  return (payloadObj) => {
    if (configuredChatTemplateKwargs) {
      const existing = payloadObj.chat_template_kwargs;
      if (existing && typeof existing === "object" && !Array.isArray(existing)) {
        payloadObj.chat_template_kwargs = {
          ...(existing as Record<string, unknown>),
          ...configuredChatTemplateKwargs,
        };
      } else {
        payloadObj.chat_template_kwargs = configuredChatTemplateKwargs;
      }
    }

    if (extraBody) {
      const collisions = Object.keys(extraBody).filter((key) => Object.hasOwn(payloadObj, key));
      if (collisions.length > 0) {
        params.logger?.warn(
          `extra_body overwriting request payload keys: ${collisions.join(", ")}`,
        );
      }
      Object.assign(payloadObj, extraBody);
    }
  };
}
