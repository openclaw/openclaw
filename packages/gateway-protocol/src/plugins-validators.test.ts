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
  validatePluginsControlUiReportParams,
  type InstallPolicyWarningErrorDetails,
} from "./index.js";

const official = { source: "official", pluginId: "workboard" };
const clawhub = { source: "clawhub", packageName: "memory-plus" };
const reload = { plugins: [{ pluginId: "notes" }] };
const enable = { pluginId: "workboard", enabled: true };
const consent = { reviewToken: "surface-sha256" };

describe("plugin lifecycle protocol validators", () => {
  it("accepts bounded activation report batches while retaining per-plugin receipts", () => {
    const report = { pluginId: "review", revision: "one", status: "activated" };
    expect(validatePluginsControlUiReportParams({ reports: [report] })).toBe(true);
    expect(
      validatePluginsControlUiReportParams({
        reports: Array.from({ length: 64 }, () => ({ ...report })),
      }),
    ).toBe(true);
    for (const params of [
      report,
      { reports: [] },
      { reports: Array.from({ length: 65 }, () => ({ ...report })) },
      { reports: [{ ...report, status: "pending" }] },
      { reports: [{ ...report, error: "x".repeat(513) }] },
      { reports: [{ ...report, extra: true }] },
      { reports: [report], extra: true },
    ]) {
      expect(validatePluginsControlUiReportParams(params)).toBe(false);
    }
  });

  it("accepts one bounded batch of exact installed owners for reload", () => {
    const target = { pluginId: "alpha", installHash: "a".repeat(64) };
    const batch = (length: number) =>
      Array.from({ length }, (_, index) => ({
        ...target,
        pluginId: `plugin-${index}`,
      }));
    for (const plugins of [
      [target],
      batch(64),
      [{ ...target, sourceDigests: { alpha: "b".repeat(64) } }],
    ]) {
      expect(validatePluginsReloadParams({ plugins })).toBe(true);
    }
    for (const request of [
      { plugins: [] },
      { plugins: batch(65) },
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

  it("accepts the CLI's npm install intent without caller trust metadata", () => {
    const request = { source: "npm", spec: "example-plugin@1.2.3", pin: true, mode: "update" };
    expect(validatePluginsInstallParams(request)).toBe(true);
    expect(validatePluginsInstallParams({ ...request, enable: false })).toBe(true);
    for (const trust of [
      { trustedSourceLinkedOfficialInstall: true },
      { bundledOrigin: true },
      { clawManaged: true },
    ]) {
      expect(validatePluginsInstallParams({ ...request, ...trust })).toBe(false);
    }
  });

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
        ...clawhub,
        version: "2.1.0",
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: consent,
      }),
    ).toBe(true);
    expect(
      validatePluginsInstallParams({
        ...official,
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: consent,
      }),
    ).toBe(true);
    expect(
      validatePluginsInstallParams({ ...official, acknowledgeInstallPolicyWarning: false }),
    ).toBe(false);
    for (const request of [
      { ...official, acknowledgeCapabilities: true },
      { ...official, acknowledgeCapabilities: false },
      { ...official, acknowledgeCapabilities: {} },
      { ...official, acknowledgeCapabilities: { reviewToken: "" } },
      { ...official, acknowledgeCapabilities: { ...consent, unexpected: true } },
      { ...clawhub, acknowledgeCapabilities: true },
      { ...clawhub, acknowledgeCapabilities: false },
    ]) {
      expect(validatePluginsInstallParams(request)).toBe(false);
    }
    expect(validatePluginsInstallParams({ ...official, packageName: "memory-plus" })).toBe(false);
  });

  it("keeps targeted reload and its capability acknowledgment closed", () => {
    expect(validatePluginsReloadParams(reload)).toBe(true);
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
      { ...reload, acknowledgeCapabilities: true },
      { ...reload, acknowledgeCapabilities: { reviewToken: "" } },
      { ...reload, acknowledgeCapabilities: { reviewToken: "reviewed", extra: true } },
    ]) {
      expect(validatePluginsReloadParams(request)).toBe(false);
    }
  });

  it("validates enablement mutations", () => {
    expect(validatePluginsSetEnabledParams({ ...enable, allowlistPolicy: "preserve" })).toBe(true);
    for (const allowlistPolicy of ["widen", "", true, {}]) {
      expect(validatePluginsSetEnabledParams({ ...enable, allowlistPolicy })).toBe(false);
    }

    expect(validatePluginsSetEnabledParams(enable)).toBe(true);
    expect(validatePluginsSetEnabledParams({ ...enable, acknowledgeCapabilities: consent })).toBe(
      true,
    );
    for (const acknowledgment of [
      true,
      false,
      {},
      { reviewToken: "" },
      { ...consent, unexpected: true },
    ]) {
      expect(
        validatePluginsSetEnabledParams({ ...enable, acknowledgeCapabilities: acknowledgment }),
      ).toBe(false);
    }
    expect(validatePluginsSetEnabledParams({ ...enable, enabled: "yes" })).toBe(false);
  });
});
