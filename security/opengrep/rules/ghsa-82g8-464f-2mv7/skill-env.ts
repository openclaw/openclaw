// Static OpenGrep fixtures. These functions are never executed.
function configuredEnv(config: any) {
  const env = config.skills.entries.example.env;
  // ruleid: openclaw-skill-env-host-injection
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}
function optionalConfiguredEnv(config: any) {
  const env = config?.skills?.entries?.example?.env;
  // ruleid: openclaw-skill-env-host-injection
  Object.assign(process.env, env);
}
function resolvedEnv(config: any) {
  const entry = resolveSkillConfig(config, "example");
  // ruleid: openclaw-skill-env-host-injection
  Object.assign(process.env, entry.env);
}
function typedConfig(entry: SkillConfig) {
  // ruleid: openclaw-skill-env-host-injection
  process.env.EXAMPLE = entry.apiKey;
}
function nestedParameter(params: any) {
  const entry = params.skillConfig;
  // ruleid: openclaw-skill-env-host-injection
  process.env.EXAMPLE = entry.apiKey;
}
function accumulatedEnv(skillConfig: any) {
  const pending: any = {};
  for (const [key, value] of Object.entries(skillConfig.env)) {
    const normalized = key.trim();
    pending[normalized] = value;
  }
  // ruleid: openclaw-skill-env-host-injection
  for (const [key, value] of Object.entries(pending)) {
    process.env[key] = value;
  }
}
function directApiKey(skillConfig: any) {
  // ruleid: openclaw-skill-env-host-injection
  process.env.EXAMPLE = skillConfig.apiKey;
}
function computedApiKey(skillConfig: any) {
  // ruleid: openclaw-skill-env-host-injection
  process.env["EXAMPLE"] = skillConfig.apiKey;
}
function primaryEnvKey(entry: any) {
  const key = entry.metadata?.primaryEnv?.trim();
  // ruleid: openclaw-skill-env-host-injection
  process.env[key] = "synthetic";
}
function snapshotKey(snapshot: any) {
  const key = snapshot.skills[0].primaryEnv;
  // ruleid: openclaw-skill-env-host-injection
  process.env[key] = "synthetic";
}
function genericSanitizer(skillConfig: any) {
  const sanitized = sanitizeEnvVars(skillConfig.env);
  // ruleid: openclaw-skill-env-host-injection
  Object.assign(process.env, sanitized.allowed);
}
function ignoredSanitizer(skillConfig: any) {
  sanitizeSkillEnvOverrides({ overrides: skillConfig.env });
  // ruleid: openclaw-skill-env-host-injection
  Object.assign(process.env, skillConfig.env);
}
function unrelatedSanitizer(skillConfig: any) {
  const sanitized = sanitizeSkillEnvOverrides({ overrides: {} });
  // ruleid: openclaw-skill-env-host-injection
  Object.assign(process.env, skillConfig.env);
}
function wrongResultField(skillConfig: any) {
  const sanitized = sanitizeSkillEnvOverrides({ overrides: skillConfig.env });
  // ruleid: openclaw-skill-env-host-injection
  process.env.EXAMPLE = sanitized.blocked[0];
}
function consumedRawResult(skillConfig: any) {
  const sanitized = sanitizeSkillEnvOverrides({ overrides: skillConfig.env });
  // ruleid: openclaw-skill-env-host-injection
  Object.assign(process.env, skillConfig.env);
}
function entryAlias(config: any) {
  const skills = config.skills.entries;
  const entry = skills.example;
  const env = entry.env;
  // ruleid: openclaw-skill-env-host-injection
  Object.assign(process.env, env);
}
function safeResult(skillConfig: any) {
  const sanitized = sanitizeSkillEnvOverrides({ overrides: skillConfig.env });
  // ok: openclaw-skill-env-host-injection
  for (const [key, value] of Object.entries(sanitized.allowed)) {
    process.env[key] = value;
  }
}
function safeInline(skillConfig: any) {
  // ok: openclaw-skill-env-host-injection
  Object.assign(process.env, sanitizeSkillEnvOverrides({ overrides: skillConfig.env }).allowed);
}
function safeAllowedAlias(skillConfig: any) {
  const sanitized = sanitizeSkillEnvOverrides({ overrides: skillConfig.env });
  const allowed = sanitized.allowed;
  // ok: openclaw-skill-env-host-injection
  Object.assign(process.env, allowed);
}
function trustedServiceEnvironment(serviceEnv: any) {
  // ok: openclaw-skill-env-host-injection
  for (const [key, value] of Object.entries(serviceEnv)) {
    process.env[key] = value;
  }
}
function savedEnvironment(saved: any) {
  // ok: openclaw-skill-env-host-injection
  Object.assign(process.env, saved);
}
function syntheticConstant() {
  // ok: openclaw-skill-env-host-injection
  process.env.EXAMPLE = "synthetic";
}
function localProjection(config: any) {
  const local: any = {};
  // ok: openclaw-skill-env-host-injection
  for (const [key, value] of Object.entries(config.skills.entries.example.env)) {
    local[key] = value;
  }
  return local;
}
function separateLocalAndHost(config: any) {
  const local = config.skills.entries.example.env;
  // ok: openclaw-skill-env-host-injection
  process.env.EXAMPLE = "synthetic";
  return local;
}
function overwrittenAllowed(skillConfig: any) {
  const sanitized = sanitizeSkillEnvOverrides({ overrides: skillConfig.env });
  sanitized.allowed = skillConfig.env;
  // ruleid: openclaw-skill-env-host-injection
  Object.assign(process.env, sanitized.allowed);
}
function reassignedResult(skillConfig: any) {
  let sanitized = sanitizeSkillEnvOverrides({ overrides: {} });
  sanitized = { allowed: skillConfig.env };
  // ruleid: openclaw-skill-env-host-injection
  Object.assign(process.env, sanitized.allowed);
}
