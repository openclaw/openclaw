// File Transfer plugin module implements node invoke policy commands behavior.
export const FILE_TRANSFER_NODE_INVOKE_COMMANDS = [
  "file.fetch",
  "file.stat",
  "dir.list",
  "dir.fetch",
  "file.write",
  "file.create",
] as const;

export type FileTransferNodeInvokeCommand = (typeof FILE_TRANSFER_NODE_INVOKE_COMMANDS)[number];
