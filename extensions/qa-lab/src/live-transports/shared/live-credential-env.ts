export function requireLiveQaEnv(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}
