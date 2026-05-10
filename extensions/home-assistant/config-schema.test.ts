import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_SERVICE_LIST,
  DEFAULT_HOME_ASSISTANT_URL,
  DEFAULT_TOKEN_REF,
} from "./config-defaults.js";
import {
  homeAssistantConfigSchema,
  parseHomeAssistantConfig,
  type HomeAssistantConfigParseIssue,
} from "./config-schema.js";

function expectIssueAtPath(
  issues: HomeAssistantConfigParseIssue[] | undefined,
  path: Array<string | number>,
): HomeAssistantConfigParseIssue {
  expect(issues, "expected a parse issue but got none").toBeTruthy();
  const matched = (issues ?? []).find(
    (issue) =>
      issue.path.length === path.length &&
      issue.path.every((segment, index) => segment === path[index]),
  );
  expect(
    matched,
    `expected issue at path ${JSON.stringify(path)}; got ${JSON.stringify(issues)}`,
  ).toBeTruthy();
  return matched as HomeAssistantConfigParseIssue;
}

const VALID_CONFIG = {
  homeAssistantUrl: DEFAULT_HOME_ASSISTANT_URL,
  tokenRef: DEFAULT_TOKEN_REF,
  allowList: ["sensor.deye_sunsynk_sol_ark_battery_state_of_charge", "switch.sonoff_10013c3266"],
  denyServiceList: [...DEFAULT_DENY_SERVICE_LIST],
  slots: {
    "gauge.battery_soc": "sensor.deye_sunsynk_sol_ark_battery_state_of_charge",
    "tile.gate_main": "switch.sonoff_10013c3266",
  },
};

describe("home-assistant config schema", () => {
  describe("happy path", () => {
    it("accepts a valid URL, tokenRef, allow-list, deny-list, and slots", () => {
      const result = parseHomeAssistantConfig(VALID_CONFIG);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.homeAssistantUrl).toBe(DEFAULT_HOME_ASSISTANT_URL);
        expect(result.data.tokenRef).toBe(DEFAULT_TOKEN_REF);
        expect(result.data.allowList).toEqual(VALID_CONFIG.allowList);
        expect(result.data.denyServiceList).toEqual(VALID_CONFIG.denyServiceList);
        expect(result.data.slots).toEqual(VALID_CONFIG.slots);
      }
    });

    it("round-trips through the SDK plugin schema's safeParse", () => {
      const safeParse = homeAssistantConfigSchema.safeParse;
      expect(safeParse).toBeTypeOf("function");
      const result = safeParse!(VALID_CONFIG);
      expect(result.success).toBe(true);
    });

    it("publishes a strict JSON Schema for loader-side validation", () => {
      const json = homeAssistantConfigSchema.jsonSchema as Record<string, unknown>;
      expect(json.type).toBe("object");
      expect(json.additionalProperties).toBe(false);
      expect(json.required).toEqual(["homeAssistantUrl", "tokenRef"]);
    });

    it("treats allowList, denyServiceList, and slots as optional", () => {
      const result = parseHomeAssistantConfig({
        homeAssistantUrl: "wss://ha.example.com:8123/api/websocket",
        tokenRef: "homeAssistant.jarvisKiosk",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowList).toEqual([]);
        expect(result.data.denyServiceList).toEqual([]);
        expect(result.data.slots).toEqual({});
      }
    });
  });

  describe("required fields", () => {
    it("rejects configs without tokenRef and points at the credentials path", () => {
      const result = parseHomeAssistantConfig({
        homeAssistantUrl: DEFAULT_HOME_ASSISTANT_URL,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = expectIssueAtPath(result.error.issues, ["tokenRef"]);
        expect(issue.message).toMatch(/credential reference/);
      }
    });

    it("rejects configs without homeAssistantUrl", () => {
      const result = parseHomeAssistantConfig({ tokenRef: DEFAULT_TOKEN_REF });
      expect(result.success).toBe(false);
      if (!result.success) {
        expectIssueAtPath(result.error.issues, ["homeAssistantUrl"]);
      }
    });
  });

  describe("homeAssistantUrl validation", () => {
    it.each([
      "http://192.168.2.41:8123/api/websocket",
      "https://homeassistant.local:8123/api/websocket",
      "192.168.2.41:8123",
      "",
    ])("rejects %s", (url) => {
      const result = parseHomeAssistantConfig({
        ...VALID_CONFIG,
        homeAssistantUrl: url,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expectIssueAtPath(result.error.issues, ["homeAssistantUrl"]);
      }
    });

    it.each(["ws://192.168.2.41:8123/api/websocket", "wss://ha.example.com/api/websocket"])(
      "accepts %s",
      (url) => {
        const result = parseHomeAssistantConfig({ ...VALID_CONFIG, homeAssistantUrl: url });
        expect(result.success).toBe(true);
      },
    );
  });

  describe("denyServiceList format", () => {
    it("rejects entries that are not <domain>.<service>", () => {
      const result = parseHomeAssistantConfig({
        ...VALID_CONFIG,
        denyServiceList: ["lock.unlock", "noDotHere"],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expectIssueAtPath(result.error.issues, ["denyServiceList", 1]);
      }
    });

    it("rejects empty-string entries", () => {
      const result = parseHomeAssistantConfig({
        ...VALID_CONFIG,
        denyServiceList: [""],
      });
      expect(result.success).toBe(false);
    });

    it("accepts the default deny-list", () => {
      const result = parseHomeAssistantConfig({
        ...VALID_CONFIG,
        denyServiceList: [...DEFAULT_DENY_SERVICE_LIST],
      });
      expect(result.success).toBe(true);
    });
  });

  describe("slots cross-field validation", () => {
    it("rejects a slot whose target is not in allowList", () => {
      const result = parseHomeAssistantConfig({
        ...VALID_CONFIG,
        slots: {
          "gauge.battery_soc": "sensor.deye_sunsynk_sol_ark_battery_state_of_charge",
          "tile.unknown": "switch.does_not_exist",
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = expectIssueAtPath(result.error.issues, ["slots", "tile.unknown"]);
        expect(issue.message).toMatch(/not in allowList/);
      }
    });

    it("rejects a slot mapped to a non-string", () => {
      const result = parseHomeAssistantConfig({
        ...VALID_CONFIG,
        slots: { "gauge.bad": 42 } as unknown as Record<string, string>,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expectIssueAtPath(result.error.issues, ["slots", "gauge.bad"]);
      }
    });
  });

  describe("structural validation", () => {
    it("rejects unknown top-level properties", () => {
      const result = parseHomeAssistantConfig({
        ...VALID_CONFIG,
        leftoverFromAnotherPlugin: true,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expectIssueAtPath(result.error.issues, ["leftoverFromAnotherPlugin"]);
      }
    });

    it("rejects non-object input", () => {
      expect(parseHomeAssistantConfig(null).success).toBe(false);
      expect(parseHomeAssistantConfig("ws://192.168.2.41").success).toBe(false);
      expect(parseHomeAssistantConfig([VALID_CONFIG]).success).toBe(false);
    });
  });
});
