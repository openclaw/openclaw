import { describe, expect, it } from "vitest";
import * as p from "./index.js";
import { validation } from "./schema/protocol-validation.test-support.js";

const install = validation(p.validatePluginsInstallParams);
const reload = validation(p.validatePluginsReloadParams);
const enable = validation(p.validatePluginsSetEnabledParams);
const report = validation(p.validatePluginsControlUiReportParams);
const consentDetails = validation(p.validateCapabilityConsentErrorDetails);
const official = { source: "official", pluginId: "workboard" };
const clawhub = { source: "clawhub", packageName: "memory-plus" };
const reloadRequest = { plugins: [{ pluginId: "notes" }] };
const enableRequest = { pluginId: "workboard", enabled: true };
const consent = { reviewToken: "surface-sha256" };
const invalidConsent = [true, false, {}, { reviewToken: "" }, { ...consent, unexpected: true }];

describe("plugin lifecycle protocol validators", () => {
  it("accepts bounded activation report batches while retaining per-plugin receipts", () => {
    const receipt = { pluginId: "review", revision: "one", status: "activated" };
    const batch = (length: number) => Array.from({ length }, () => ({ ...receipt }));
    report.accepts({ reports: [receipt] }, { reports: batch(64) });
    report.rejects(
      receipt,
      { reports: [] },
      { reports: batch(65) },
      { reports: [{ ...receipt, status: "pending" }] },
      { reports: [{ ...receipt, error: "x".repeat(513) }] },
      { reports: [{ ...receipt, extra: true }] },
      { reports: [receipt], extra: true },
    );
  });
  it("accepts one bounded batch of exact installed owners for reload", () => {
    const target = { pluginId: "alpha", installHash: "a".repeat(64) };
    const batch = (length: number) =>
      Array.from({ length }, (_, index) => ({ ...target, pluginId: `plugin-${index}` }));
    reload.accepts(
      { plugins: [target] },
      { plugins: batch(64) },
      { plugins: [{ ...target, sourceDigests: { alpha: "b".repeat(64) } }] },
    );
    reload.rejects(
      { plugins: [] },
      { plugins: batch(65) },
      { plugins: [target, target] },
      { plugins: [{ ...target, installHash: "" }] },
      { plugins: [{ ...target, installHash: "A".repeat(64) }] },
      { plugins: [{ ...target, sourceDigests: { alpha: "not-a-digest" } }] },
      { plugins: [target], pluginId: "alpha" },
      { plugins: [{ ...target, trusted: true }] },
    );
  });
  it("accepts the CLI's npm install intent without caller trust metadata", () => {
    const request = { source: "npm", spec: "example-plugin@1.2.3", pin: true, mode: "update" };
    install.accepts(request, { ...request, enable: false });
    for (const trust of [
      { trustedSourceLinkedOfficialInstall: true },
      { bundledOrigin: true },
      { clawManaged: true },
    ]) {
      install.rejects({ ...request, ...trust });
    }
  });
  it("exports install policy warning details from the package root", () => {
    const details: p.InstallPolicyWarningErrorDetails = {
      installPolicyCode: p.INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
      targetName: "memory-plus",
      targetType: "plugin",
      requestMode: "install",
      reason: "review this plugin",
    };
    expect(p.readInstallPolicyWarningErrorDetails(details)).toEqual(details);
  });
  it("round-trips closed capability consent details through the public package boundary", () => {
    const details = p.buildCapabilityConsentErrorDetails({
      pluginId: "memory-plus",
      reviewToken: "surface-sha256",
      widened: { tools: ["memory_search"], contracts: ["workerProviders: worker"] },
      acceptedAt: "2026-08-25T00:00:00.000Z",
    });
    expect(details.capabilityConsentCode).toBe(p.PLUGIN_CAPABILITY_CONSENT_REQUIRED);
    consentDetails.accepts(details);
    expect(p.readCapabilityConsentErrorDetails(details)).toEqual(details);
    for (const fields of [
      { capabilityConsentCode: "incorrect" },
      { pluginId: "" },
      { reviewToken: "" },
      { widened: { tools: [""] } },
      { widened: { unexpected: ["tool"] } },
      { acceptedAt: "" },
      { name: "Memory Plus" },
      { unexpected: true },
    ]) {
      const invalid = { ...details, ...fields };
      consentDetails.rejects(invalid);
      expect(p.readCapabilityConsentErrorDetails(invalid)).toBeUndefined();
    }
    const whitespace = p.buildCapabilityConsentErrorDetails({
      pluginId: " memory-plus ",
      reviewToken: " surface-sha256 ",
      widened: { contracts: [" workerProviders: worker "] },
      acceptedAt: " 2026-08-25T00:00:00.000Z ",
    });
    consentDetails.accepts(whitespace);
    expect(p.readCapabilityConsentErrorDetails(whitespace)).toEqual(whitespace);
  });
  it("accepts only URL-safe plugin discovery ids", () => {
    const catalog = validation(p.validatePluginsCatalogGetParams);
    catalog.accepts({ id: "ch_c2FtcGxl" });
    catalog.rejects({ id: "publisher/plugin" });
  });
  it("keeps official and ClawHub install requests distinct", () => {
    const acknowledgments = {
      acknowledgeInstallPolicyWarning: true,
      acknowledgeCapabilities: consent,
    };
    install.accepts(
      { ...clawhub, version: "2.1.0", ...acknowledgments },
      { ...official, ...acknowledgments },
    );
    install.rejects(
      { ...official, acknowledgeInstallPolicyWarning: false },
      { ...official, packageName: "memory-plus" },
      { ...clawhub, acknowledgeCapabilities: true },
      { ...clawhub, acknowledgeCapabilities: false },
    );
  });
  it("keeps targeted reload closed", () => {
    reload.accepts(reloadRequest, {
      plugins: [{ pluginId: "notes", installHash: "a".repeat(64) }],
      acknowledgeCapabilities: { reviewToken: "reviewed-artifact" },
    });
    reload.rejects(
      {},
      { pluginId: "notes" },
      { plugins: [{ pluginId: "" }] },
      { plugins: [{ pluginId: "notes", enabled: true }] },
    );
  });
  it.each([
    ["install", install, official],
    ["reload", reload, reloadRequest],
    ["enable", enable, enableRequest],
  ] as const)("keeps %s capability acknowledgment closed", (_, validate, base) => {
    validate.accepts({ ...base, acknowledgeCapabilities: consent });
    for (const acknowledgeCapabilities of invalidConsent) {
      validate.rejects({ ...base, acknowledgeCapabilities });
    }
  });
  it("validates enablement mutations", () => {
    enable.accepts(enableRequest, { ...enableRequest, allowlistPolicy: "preserve" });
    for (const allowlistPolicy of ["widen", "", true, {}]) {
      enable.rejects({ ...enableRequest, allowlistPolicy });
    }
    enable.rejects({ ...enableRequest, enabled: "yes" });
  });
});
