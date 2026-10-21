// Static OpenGrep fixtures. These functions are never executed.
function callerOverrides(value) {
  // ruleid: openclaw-dangerous-host-env-override-pivots
  sanitizeHostExecEnv({ overrides: { GIT_SSH_COMMAND: value } });
  // ruleid: openclaw-dangerous-host-env-override-pivots
  sanitizeSystemRunEnvOverrides({ overrides: { CC: value }, shellWrapper: true });
  // ruleid: openclaw-dangerous-host-env-override-pivots
  sanitizeHostExecEnv({ overrides: { GIT_CONFIG_COUNT: value } });
  // ruleid: openclaw-dangerous-host-env-override-pivots
  sanitizeSystemRunEnvOverrides({ overrides: { GIT_CONFIG_PARAMETERS: value } });
  // ruleid: openclaw-dangerous-host-env-override-pivots
  sanitizeHostExecEnv({ overrides: { NPM_CONFIG_USERCONFIG: value } });
  // ruleid: openclaw-dangerous-host-env-override-pivots
  sanitizeSystemRunEnvOverrides({ overrides: { CARGO_REGISTRIES_PRIVATE_INDEX: value } });
  // ruleid: openclaw-dangerous-host-env-override-pivots
  sanitizeHostExecEnv({ overrides: { TF_VAR_SECRET: value } });
  // ruleid: openclaw-dangerous-host-env-override-pivots
  sanitizeHostExecEnv({ overrides: { ["GIT_CONFIG_PARAMETERS"]: value } });
}

function normalizedOverrideNames(value) {
  // ruleid: openclaw-dangerous-host-env-override-pivots
  sanitizeHostExecEnv({ overrides: { " git_config_parameters ": value } });
}

function trustedBaseEnvironment(value) {
  // ok: openclaw-dangerous-host-env-override-pivots
  sanitizeHostExecEnv({ baseEnv: { GIT_CONFIG_PARAMETERS: value } });
  // ok: openclaw-dangerous-host-env-override-pivots
  return { env: { GIT_SSH_COMMAND: value } };
}

function unrelatedOverrideValue() {
  // ok: openclaw-dangerous-host-env-override-pivots
  return sanitizeHostExecEnv({ overrides: { TERM: "GIT_SSH_COMMAND" } });
}

function policyBlocklists() {
  return {
    // ok: openclaw-dangerous-host-env-override-pivots
    blockedOverrideKeys: ["GIT_SSH_COMMAND", "GIT_CONFIG_PARAMETERS"],
    // ok: openclaw-dangerous-host-env-override-pivots
    blockedOverridePrefixes: ["GIT_CONFIG_", "NPM_CONFIG_", "CARGO_REGISTRIES_", "TF_VAR_"],
  };
}

function comparisons(name) {
  return {
    // ok: openclaw-dangerous-host-env-override-pivots
    matches: name === "GIT_CONFIG_PARAMETERS",
    // ok: openclaw-dangerous-host-env-override-pivots
    absent: !["GIT_SSH_COMMAND"].includes(name),
  };
}

// Regression: the private process helper clears inherited values before adding host policy.
function withCodexAppServerGitConfig(options, parameters) {
  const env = resolveCodexAppServerSpawnEnv(options);
  const key =
    process.platform === "win32"
      ? Object.keys(env)
          .toSorted()
          .find((name) => name.toUpperCase() === "GIT_CONFIG_PARAMETERS")
      : "GIT_CONFIG_PARAMETERS";
  const inherited = key === undefined ? undefined : env[key];
  return {
    ...options,
    env: {
      ...options.env,
      GIT_CONFIG_PARAMETERS: appendCodexGitConfigParameters(inherited, parameters),
    },
    ...(options.clearEnv
      ? {
          clearEnv: options.clearEnv.filter(
            (name) =>
              (process.platform === "win32" ? name.trim().toUpperCase() : name.trim()) !==
              // ok: openclaw-dangerous-host-env-override-pivots
              "GIT_CONFIG_PARAMETERS",
          ),
        }
      : {}),
  };
}
