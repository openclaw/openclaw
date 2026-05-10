import {
  buildPluginConfigSchema,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";

/**
 * Validated shape of `plugins.entries["home-assistant"].config`.
 *
 * Cross-field invariants enforced here (not expressible in the manifest's
 * JSON Schema):
 *   - homeAssistantUrl must start with ws:// or wss://
 *   - every entry in denyServiceList must look like `<domain>.<service>`
 *   - every slot value must reference an entity present in allowList
 */
export type HomeAssistantConfig = {
  homeAssistantUrl: string;
  tokenRef: string;
  allowList: readonly string[];
  denyServiceList: readonly string[];
  slots: Readonly<Record<string, string>>;
};

export type HomeAssistantConfigParseIssue = {
  path: Array<string | number>;
  message: string;
};

export type HomeAssistantConfigParseResult =
  | { success: true; data: HomeAssistantConfig }
  | { success: false; error: { issues: HomeAssistantConfigParseIssue[] } };

const SERVICE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function pushIssue(
  issues: HomeAssistantConfigParseIssue[],
  path: Array<string | number>,
  message: string,
): void {
  issues.push({ path, message });
}

export function parseHomeAssistantConfig(value: unknown): HomeAssistantConfigParseResult {
  const issues: HomeAssistantConfigParseIssue[] = [];

  if (!isPlainRecord(value)) {
    pushIssue(issues, [], "expected a Home Assistant plugin config object");
    return { success: false, error: { issues } };
  }

  const known = new Set(["homeAssistantUrl", "tokenRef", "allowList", "denyServiceList", "slots"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      pushIssue(issues, [key], `unknown property "${key}"`);
    }
  }

  const url = value.homeAssistantUrl;
  if (typeof url !== "string" || url.trim().length === 0) {
    pushIssue(issues, ["homeAssistantUrl"], "homeAssistantUrl is required");
  } else if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    pushIssue(issues, ["homeAssistantUrl"], "homeAssistantUrl must start with ws:// or wss://");
  }

  const tokenRef = value.tokenRef;
  if (typeof tokenRef !== "string" || tokenRef.trim().length === 0) {
    pushIssue(
      issues,
      ["tokenRef"],
      "tokenRef is required (credential reference, never the literal token)",
    );
  }

  const allowListRaw = value.allowList ?? [];
  let allowList: string[] = [];
  if (allowListRaw === undefined) {
    allowList = [];
  } else if (!isStringArray(allowListRaw)) {
    pushIssue(issues, ["allowList"], "allowList must be an array of entity-id strings");
  } else {
    allowList = allowListRaw;
  }

  const denyServiceListRaw = value.denyServiceList ?? [];
  let denyServiceList: string[] = [];
  if (denyServiceListRaw === undefined) {
    denyServiceList = [];
  } else if (!isStringArray(denyServiceListRaw)) {
    pushIssue(
      issues,
      ["denyServiceList"],
      "denyServiceList must be an array of <domain>.<service> strings",
    );
  } else {
    denyServiceList = denyServiceListRaw;
    denyServiceListRaw.forEach((entry, index) => {
      if (!SERVICE_PATTERN.test(entry)) {
        pushIssue(
          issues,
          ["denyServiceList", index],
          `denyServiceList[${index}] "${entry}" is not formatted as <domain>.<service>`,
        );
      }
    });
  }

  const slotsRaw = value.slots ?? {};
  let slots: Record<string, string> = {};
  if (slotsRaw === undefined) {
    slots = {};
  } else if (!isPlainRecord(slotsRaw)) {
    pushIssue(issues, ["slots"], "slots must be an object mapping slot name to entity id");
  } else {
    const allowSet = new Set(allowList);
    for (const [slotName, slotTarget] of Object.entries(slotsRaw)) {
      if (typeof slotTarget !== "string" || slotTarget.length === 0) {
        pushIssue(
          issues,
          ["slots", slotName],
          `slot "${slotName}" must map to a non-empty entity id string`,
        );
        continue;
      }
      if (allowList.length > 0 && !allowSet.has(slotTarget)) {
        pushIssue(
          issues,
          ["slots", slotName],
          `slot "${slotName}" maps to "${slotTarget}" which is not in allowList`,
        );
        continue;
      }
      slots[slotName] = slotTarget;
    }
  }

  if (issues.length > 0) {
    return { success: false, error: { issues } };
  }

  return {
    success: true,
    data: {
      homeAssistantUrl: url as string,
      tokenRef: tokenRef as string,
      allowList,
      denyServiceList,
      slots,
    },
  };
}

const HOME_ASSISTANT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["homeAssistantUrl", "tokenRef"],
  properties: {
    homeAssistantUrl: { type: "string", minLength: 1 },
    tokenRef: { type: "string", minLength: 1 },
    allowList: { type: "array", items: { type: "string" } },
    denyServiceList: { type: "array", items: { type: "string" } },
    slots: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

/**
 * The plugin config schema surfaced to the host. Uses the SDK's
 * `buildPluginConfigSchema` for shape, but routes parsing through
 * `parseHomeAssistantConfig` so cross-field invariants (URL scheme, slot
 * targets in allowList, service format) run on every config validation pass.
 */
export const homeAssistantConfigSchema: OpenClawPluginConfigSchema = buildPluginConfigSchema(
  // We don't need a zod instance here -- the safeParse override covers all
  // parsing, and the JSON Schema below is what callers without a runtime
  // instance see. Pass an inert object that satisfies the helper's typing.
  { _def: { typeName: "ZodAny" } } as never,
  {
    safeParse: (value: unknown) => parseHomeAssistantConfig(value),
  },
);

// `buildPluginConfigSchema` falls back to a permissive `additionalProperties: true`
// JSON Schema when the supplied schema lacks `toJSONSchema`. Override with the
// strict manifest-equivalent shape so loader-side validation matches our intent.
(homeAssistantConfigSchema as { jsonSchema?: unknown }).jsonSchema = HOME_ASSISTANT_JSON_SCHEMA;
