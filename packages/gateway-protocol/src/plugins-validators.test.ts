import { describe, expect, it } from "vitest";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  PLUGIN_CAPABILITY_CONSENT_REQUIRED,
  buildCapabilityConsentErrorDetails,
  readCapabilityConsentErrorDetails,
  readInstallPolicyWarningErrorDetails,
  validateCapabilityConsentErrorDetails,
  validatePluginsInstallParams,
  validatePluginsReloadParams,
  validatePluginsCatalogGetParams,
  validatePluginsSetEnabledParams,
  type InstallPolicyWarningErrorDetails,
} from "./index.js";

describe("plugin lifecycle protocol validators", () => {
  it("accepts one bounded batch of exact installed owners for reload", () => {
    const target = { pluginId: "alpha", installHash: "a".repeat(64) };
    expect(validatePluginsReloadParams({ plugins: [target] })).toBe(true);
    expect(
      validatePluginsReloadParams({
        plugins: Array.from({ length: 64 }, (_, index) => ({
          ...target,
          pluginId: `plugin-${index}`,
        })),
      }),
    ).toBe(true);
    expect(
      validatePluginsReloadParams({
        plugins: [{ ...target, sourceDigests: { alpha: "b".repeat(64) } }],
      }),
    ).toBe(true);
    for (const request of [
      { plugins: [] },
      {
        plugins: Array.from({ length: 65 }, (_, index) => ({
          ...target,
          pluginId: `plugin-${index}`,
        })),
      },
      { plugins: [target, target] },
      { plugins: [{ ...target, installHash: "" }] },
      { plugins: [{ ...target, installHash: "A".repeat(64) }] },
      { plugins: [{ ...target, sourceDigests: { alpha: "not-a-digest" } }] },
      { plugins: [target], pluginId: "alpha" },
      { plugins: [{ ...target, trusted: true }] },
    ]) {
      expect(validatePluginsReloadParams(request)).toBe(false);
    }
  });

  it.each([{ source: "npm", spec: "example-plugin@1.2.3", pin: true, mode: "update" }])(
    "accepts the CLI's $source install intent without caller trust metadata",
    (request) => {
      expect(validatePluginsInstallParams(request)).toBe(true);
      expect(validatePluginsInstallParams({ ...request, enable: false })).toBe(true);
      for (const trust of [
        { trustedSourceLinkedOfficialInstall: true },
        { bundledOrigin: true },
        { clawManaged: true },
      ]) {
        expect(validatePluginsInstallParams({ ...request, ...trust })).toBe(false);
      }
    },
  );

  it("exports install policy warning details from the package root", () => {
    const details: InstallPolicyWarningErrorDetails = {
      installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
      targetName: "memory-plus",
      targetType: "plugin",
      requestMode: "install",
      reason: "review this plugin",
    };

    expect(readInstallPolicyWarningErrorDetails(details)).toEqual(details);
  });

  it("round-trips closed capability consent details through the public package boundary", () => {
    const details = buildCapabilityConsentErrorDetails({
      pluginId: "memory-plus",
      reviewToken: "surface-sha256",
      widened: { tools: ["memory_search"], contracts: ["workerProviders: worker"] },
      acceptedAt: "2026-08-25T00:00:00.000Z",
    });

    expect(details.capabilityConsentCode).toBe(PLUGIN_CAPABILITY_CONSENT_REQUIRED);
    expect(validateCapabilityConsentErrorDetails(details)).toBe(true);
    expect(readCapabilityConsentErrorDetails(details)).toEqual(details);

    for (const invalidDetails of [
      { ...details, capabilityConsentCode: "incorrect" },
      { ...details, pluginId: "" },
      { ...details, reviewToken: "" },
      { ...details, widened: { tools: [""] } },
      { ...details, widened: { unexpected: ["tool"] } },
      { ...details, acceptedAt: "" },
      { ...details, name: "Memory Plus" },
      { ...details, unexpected: true },
    ]) {
      expect(validateCapabilityConsentErrorDetails(invalidDetails)).toBe(false);
      expect(readCapabilityConsentErrorDetails(invalidDetails)).toBeUndefined();
    }

    const whitespaceDetails = buildCapabilityConsentErrorDetails({
      pluginId: " memory-plus ",
      reviewToken: " surface-sha256 ",
      widened: { contracts: [" workerProviders: worker "] },
      acceptedAt: " 2026-08-25T00:00:00.000Z ",
    });
    expect(validateCapabilityConsentErrorDetails(whitespaceDetails)).toBe(true);
    expect(readCapabilityConsentErrorDetails(whitespaceDetails)).toEqual(whitespaceDetails);
  });

  it("accepts only URL-safe plugin discovery ids", () => {
    expect(validatePluginsCatalogGetParams({ id: "ch_c2FtcGxl" })).toBe(true);
    expect(validatePluginsCatalogGetParams({ id: "publisher/plugin" })).toBe(false);
  });

  it("keeps official and ClawHub install requests distinct", () => {
    expect(
      validatePluginsInstallParams({
        source: "clawhub",
        packageName: "memory-plus",
        version: "2.1.0",
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: { reviewToken: "surface-sha256" },
      }),
    ).toBe(true);
    expect(
      validatePluginsInstallParams({
        source: "official",
        pluginId: "workboard",
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: { reviewToken: "surface-sha256" },
      }),
    ).toBe(true);
    expect(
      validatePluginsInstallParams({
        source: "official",
        pluginId: "workboard",
        acknowledgeInstallPolicyWarning: false,
      }),
    ).toBe(false);
    for (const request of [
      { source: "official", pluginId: "workboard", acknowledgeCapabilities: true },
      { source: "official", pluginId: "workboard", acknowledgeCapabilities: false },
      { source: "official", pluginId: "workboard", acknowledgeCapabilities: {} },
      {
        source: "official",
        pluginId: "workboard",
        acknowledgeCapabilities: { reviewToken: "" },
      },
      {
        source: "official",
        pluginId: "workboard",
        acknowledgeCapabilities: { reviewToken: "surface-sha256", unexpected: true },
      },
      { source: "clawhub", packageName: "memory-plus", acknowledgeCapabilities: true },
      { source: "clawhub", packageName: "memory-plus", acknowledgeCapabilities: false },
    ]) {
      expect(validatePluginsInstallParams(request)).toBe(false);
    }
    expect(
      validatePluginsInstallParams({
        source: "official",
        pluginId: "workboard",
        packageName: "memory-plus",
      }),
    ).toBe(false);
  });

  it("keeps targeted reload and its capability acknowledgment closed", () => {
    expect(validatePluginsReloadParams({ plugins: [{ pluginId: "notes" }] })).toBe(true);
    expect(
      validatePluginsReloadParams({
        plugins: [{ pluginId: "notes", installHash: "a".repeat(64) }],
        acknowledgeCapabilities: { reviewToken: "reviewed-artifact" },
      }),
    ).toBe(true);
    for (const request of [
      {},
      { pluginId: "notes" },
      { plugins: [{ pluginId: "" }] },
      { plugins: [{ pluginId: "notes", enabled: true }] },
      { plugins: [{ pluginId: "notes" }], acknowledgeCapabilities: true },
      { plugins: [{ pluginId: "notes" }], acknowledgeCapabilities: { reviewToken: "" } },
      {
        plugins: [{ pluginId: "notes" }],
        acknowledgeCapabilities: { reviewToken: "reviewed", extra: true },
      },
    ]) {
      expect(validatePluginsReloadParams(request)).toBe(false);
    }
  });

  it("validates enablement mutations", () => {
    expect(
      validatePluginsSetEnabledParams({
        pluginId: "workboard",
        enabled: true,
        allowlistPolicy: "preserve",
      }),
    ).toBe(true);
    for (const allowlistPolicy of ["widen", "", true, {}]) {
      expect(
        validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: true, allowlistPolicy }),
      ).toBe(false);
    }

    expect(validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: true })).toBe(true);
    expect(
      validatePluginsSetEnabledParams({
        pluginId: "workboard",
        enabled: true,
        acknowledgeCapabilities: { reviewToken: "surface-sha256" },
      }),
    ).toBe(true);
    for (const acknowledgment of [
      true,
      false,
      {},
      { reviewToken: "" },
      { reviewToken: "surface-sha256", unexpected: true },
    ]) {
      expect(
        validatePluginsSetEnabledParams({
          pluginId: "workboard",
          enabled: true,
          acknowledgeCapabilities: acknowledgment,
        }),
      ).toBe(false);
    }
    expect(validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: "yes" })).toBe(false);
  });
});
