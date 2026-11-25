import { extractErrorCode, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import {
  prepareOpenClawProfile,
  usesOpenClawMockKeychain,
} from "./src/browser/chrome.profile-decoration.js";
import { ensureOutputDirectory } from "./src/browser/output-directories.js";

export type ProfileFilesystemCommand =
  | { type: "lock"; target: string; owner: string }
  | { type: "output-directory"; path: string }
  | { type: "mock-keychain"; userDataDir: string }
  | {
      type: "decorate";
      userDataDir: string;
      options: NonNullable<Parameters<typeof prepareOpenClawProfile>[1]>;
    };

export type ProfileFilesystemReply = {
  mockKeychain?: boolean;
  failure?: { error: Error; name: string; code?: string; lockPath?: string };
};

serveWorkerTasks<ProfileFilesystemReply, ProfileFilesystemCommand>(
  async (command, channel): Promise<ProfileFilesystemReply> => {
    try {
      switch (command.type) {
        case "lock":
          if (!channel) {
            throw new Error("Browser lifecycle lock requires a host conversation");
          }
          await withFileLock(
            command.target,
            {
              retries: { retries: 600, factor: 1, minTimeout: 100, maxTimeout: 100 },
              stale: 60_000,
              staleRecovery: "remove-if-definitely-stale",
              reentrantOwner: command.owner,
            },
            async () => {
              const response = await channel.request(undefined);
              response.consumed();
            },
          );
          return {};
        case "output-directory":
          await ensureOutputDirectory(command.path);
          return {};
        case "mock-keychain":
          return { mockKeychain: usesOpenClawMockKeychain(command.userDataDir) };
        case "decorate":
          await prepareOpenClawProfile(command.userDataDir, command.options);
          return {};
        default:
          throw new Error("Unknown browser profile filesystem operation");
      }
    } catch (caught) {
      const error = toErrorObject(caught, "Browser profile filesystem operation failed");
      return {
        failure: {
          error,
          name: error.name,
          code: extractErrorCode(error),
          lockPath:
            "lockPath" in error && typeof error.lockPath === "string" ? error.lockPath : undefined,
        },
      };
    }
  },
);
