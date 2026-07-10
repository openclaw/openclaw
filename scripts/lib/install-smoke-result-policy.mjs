function requireResult(errors, jobs, name, expected) {
  if (jobs[name] !== expected) {
    errors.push(`${name}: expected ${expected}, got ${jobs[name] || "missing"}`);
  }
}

export function validateInstallSmokeJobResults({
  jobs,
  rootImageTransport,
  runBunGlobalInstallSmoke,
  runFastInstallSmoke,
  runFullInstallSmoke,
}) {
  const errors = [];
  requireResult(errors, jobs, "preflight", "success");

  if (rootImageTransport !== "registry" && rootImageTransport !== "artifact") {
    errors.push("invalid root image transport");
  }

  if (runFullInstallSmoke) {
    requireResult(errors, jobs, "fastInstallSmoke", "skipped");
    requireResult(
      errors,
      jobs,
      "registryImageProducer",
      rootImageTransport === "registry" ? "success" : "skipped",
    );
    requireResult(
      errors,
      jobs,
      "artifactImageProducer",
      rootImageTransport === "artifact" ? "success" : "skipped",
    );
    requireResult(errors, jobs, "qrPackageInstallSmoke", "success");
    requireResult(errors, jobs, "rootDockerfileSmokes", "success");
    requireResult(errors, jobs, "installerSmoke", "success");
    requireResult(
      errors,
      jobs,
      "bunGlobalInstallSmoke",
      runBunGlobalInstallSmoke ? "success" : "skipped",
    );
    return errors;
  }

  requireResult(errors, jobs, "fastInstallSmoke", runFastInstallSmoke ? "success" : "skipped");
  requireResult(errors, jobs, "registryImageProducer", "skipped");
  requireResult(errors, jobs, "artifactImageProducer", "skipped");
  requireResult(errors, jobs, "qrPackageInstallSmoke", "skipped");
  requireResult(errors, jobs, "rootDockerfileSmokes", "skipped");
  requireResult(errors, jobs, "installerSmoke", "skipped");
  requireResult(errors, jobs, "bunGlobalInstallSmoke", "skipped");
  return errors;
}
