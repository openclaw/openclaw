const POLICY_INCLUDE = 'source "${BASH_SOURCE[0]%${BASH_SOURCE[0]##*/}}./install-policy.sh"';

// The source can come from a sealed archive. Never evaluate candidate shell code
// or load its generator while assembling a privileged install-smoke payload.
export function assembleStandaloneInstaller(source, readPolicy) {
  if (!source.includes(POLICY_INCLUDE)) {
    return source;
  }
  if (source.indexOf(POLICY_INCLUDE) !== source.lastIndexOf(POLICY_INCLUDE)) {
    throw new Error("Installer must include shared policy exactly once");
  }
  return source.replace(POLICY_INCLUDE, () => readPolicy().trimEnd());
}
