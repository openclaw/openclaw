export function publishedPluginPolicy(snapshot, { sanitize, boundedList }) {
  const expectedCell =
    snapshot.scenario === "legacy-operator-state" && snapshot.baseline?.version === "2026.9.2";
  const proof = snapshot.pluginPolicy;
  if (proof === undefined || proof === null) {
    if (
      expectedCell &&
      Array.isArray(snapshot.phases) &&
      snapshot.phases.some(
        (event) => event?.phase === "verify-sole-plugin-policy" && event.status === "passed",
      )
    ) {
      throw new Error("Missing sole-plugin policy evidence after completed probe");
    }
    return undefined;
  }
  const pluginIds = (value) => {
    const ids = boundedList(value);
    if (
      !ids.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)) ||
      new Set(ids).size !== ids.length
    ) {
      throw new Error("Invalid sole-plugin policy evidence");
    }
    return ids.toSorted();
  };
  const baselineEnabled = pluginIds(proof.baselineEnabledPlugins);
  const candidateEnabled = pluginIds(proof.candidateEnabledPlugins);
  const active = pluginIds(proof.activePlugins);
  if (
    !expectedCell ||
    proof?.baselineVersion !== snapshot.baseline.version ||
    proof.candidateVersion !== snapshot.candidate.version ||
    proof.candidateVersion !== snapshot.installedVersion ||
    proof.configuredChannelPlugin !== "telegram" ||
    proof.selectedMemoryPlugin !== "memory-core" ||
    !Array.isArray(proof.deniedPlugins) ||
    proof.deniedPlugins.length !== 1 ||
    proof.deniedPlugins[0] !== "device-pair" ||
    !baselineEnabled.includes("telegram") ||
    !baselineEnabled.includes("memory-core") ||
    baselineEnabled.includes("webhooks") ||
    baselineEnabled.includes("device-pair") ||
    JSON.stringify(baselineEnabled) !== JSON.stringify(candidateEnabled) ||
    active.some((id) => !baselineEnabled.includes(id)) ||
    proof.ordinaryHooksPreserved !== true ||
    proof.hookUnauthorizedStatus !== 401 ||
    !Array.isArray(proof.oldAllowlist) ||
    proof.oldAllowlist.length !== 1 ||
    proof.oldAllowlist[0] !== "webhooks" ||
    typeof proof.hooksSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(proof.hooksSha256)
  ) {
    throw new Error("Invalid sole-plugin policy evidence");
  }
  return {
    baselineVersion: sanitize(proof.baselineVersion, "plugin policy"),
    candidateVersion: sanitize(proof.candidateVersion, "plugin policy"),
    oldAllowlist: ["webhooks"],
    baselineEnabledPlugins: baselineEnabled,
    candidateEnabledPlugins: candidateEnabled,
    activePlugins: active,
    configuredChannelPlugin: "telegram",
    selectedMemoryPlugin: "memory-core",
    deniedPlugins: ["device-pair"],
    ordinaryHooksPreserved: true,
    hooksSha256: proof.hooksSha256,
    hookUnauthorizedStatus: 401,
  };
}
