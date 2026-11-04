export const NODE_COMPUTER_RESOURCE_FETCH_COMMAND = "computer.resource.fetch";
/** These wire operations act only on a session-owned isolated machine. */
export const SESSION_ENVIRONMENT_NODE_COMMANDS = [
  "file.fetch",
  "file.stat",
  "file.write",
  "file.create",
  "dir.fetch",
  "dir.list",
  "browser.proxy",
  "browser.proxy.upload.v1",
  NODE_COMPUTER_RESOURCE_FETCH_COMMAND,
] as const;
export type SessionEnvironmentNodeCommand = (typeof SESSION_ENVIRONMENT_NODE_COMMANDS)[number];
