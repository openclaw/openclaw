import { describe, expect, it } from "vitest";
import {
  resolveMSTeamsSdkCloudOptions,
  validateMSTeamsProactiveServiceUrlBoundary,
} from "./cloud.js";

const publicUrl = "https://smba.trafficmanager.net";
const chinaUrl = "https://msteams.botframework.azure.cn";
const governmentUrl = "https://smba.infra.dod.teams.microsoft.us";

describe("resolveMSTeamsSdkCloudOptions", () => {
  it.each([
    [{}, { cloud: "Public" }],
    [{ cloud: "China" }, { cloud: "China" }],
    [
      { cloud: "USGovDoD", serviceUrl: ` ${governmentUrl}/teams ` },
      { cloud: "USGovDoD", serviceUrl: `${governmentUrl}/teams` },
    ],
  ] as const)("resolves %j", (config, expected) => {
    expect(resolveMSTeamsSdkCloudOptions(config)).toEqual(expected);
  });

  it("requires a service URL for government clouds", () => {
    expect(() => resolveMSTeamsSdkCloudOptions({ cloud: "USGov" })).toThrow(
      /channels\.msteams\.cloud=USGov requires channels\.msteams\.serviceUrl/,
    );
  });
});

describe("proactive service URL boundary", () => {
  const conversationId = "19:conversation@thread.tacv2";
  it.each([
    ["USGov", "not a URL", "not a URL", "cloud=USGov requires channels.msteams.serviceUrl"],
    ["China", publicUrl, "not a URL", "not a Microsoft Teams China Bot Framework"],
    ["Public", chinaUrl, "not a URL", "requires channels.msteams.cloud=China"],
    ["Public", publicUrl, " ", "stored conversation reference is missing a valid serviceUrl"],
    ["Public", undefined, "https://other.example/teams", "not a Microsoft Teams public-cloud"],
    ["China", undefined, publicUrl, "not a Microsoft Teams China Bot Framework"],
    ["USGovDoD", governmentUrl, publicUrl, "does not match configured Teams SDK serviceUrl host"],
  ] as const)(
    "rejects %s configured=%s stored=%s",
    (cloud, configuredServiceUrl, storedServiceUrl, reason) => {
      expect(() =>
        validateMSTeamsProactiveServiceUrlBoundary({
          cloud,
          conversationId,
          configuredServiceUrl,
          storedServiceUrl,
        }),
      ).toThrow(reason);
    },
  );

  it.each([
    ["Public", undefined, `${publicUrl}/amer/`],
    ["China", "not a URL", "https://botframework.azure.cn/teams/"],
    ["China", undefined, `${chinaUrl}/teams/`],
    [
      "USGov",
      `${governmentUrl}/configured/?query=1#fragment`,
      ` ${governmentUrl.toUpperCase()}/different/// `,
    ],
    ["China", `${chinaUrl}/configured/`, `${chinaUrl}/different/`],
  ] as const)(
    "admits %s configured=%s stored=%s",
    (cloud, configuredServiceUrl, storedServiceUrl) => {
      expect(() =>
        validateMSTeamsProactiveServiceUrlBoundary({
          cloud,
          conversationId,
          configuredServiceUrl,
          storedServiceUrl,
        }),
      ).not.toThrow();
    },
  );
});
