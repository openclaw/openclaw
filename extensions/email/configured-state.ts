export function hasEmailConfiguredState(params: { env?: NodeJS.ProcessEnv }): boolean {
  return (
    typeof params.env?.EMAIL_IMAP_HOST === "string" &&
    params.env.EMAIL_IMAP_HOST.trim().length > 0 &&
    typeof params.env?.EMAIL_IMAP_USERNAME === "string" &&
    params.env.EMAIL_IMAP_USERNAME.trim().length > 0
  );
}
