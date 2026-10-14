import {
  localAgentAvatarRevision,
  type LocalAgentAvatarRead,
  type LocalAgentAvatarResult,
} from "./identity-avatar-file.js";
import { prepareCachedIdentityRead } from "./identity-file-runtime.js";

type LoadedAvatar = Extract<LocalAgentAvatarResult, { ok: true }>;

export function prepareLocalAgentAvatar(
  input: LocalAgentAvatarRead,
): Promise<LocalAgentAvatarResult> {
  return prepareCachedIdentityRead<"localAgentAvatar", LocalAgentAvatarResult, LoadedAvatar>({
    runtimeKey: Symbol.for("openclaw.localAgentAvatars"),
    worker: "localAgentAvatar",
    readerName: "Avatar reader",
    key: () => JSON.stringify([input.workspaceDir, input.source, input.readBody]),
    input: (_key, knownRevision) => ({ ...input, knownRevision }),
    revision: (entry) => localAgentAvatarRevision(entry.file),
    sizeOf: (entry) => entry.file.body?.byteLength ?? 0,
    prepare: (result, previous) => {
      if ("kind" in result) {
        return previous;
      }
      return result.ok
        ? {
            ok: true,
            file: {
              ...result.file,
              body: result.file.body
                ? Buffer.from(
                    result.file.body.buffer,
                    result.file.body.byteOffset,
                    result.file.body.byteLength,
                  )
                : undefined,
            },
          }
        : result;
    },
    isLoaded: (result): result is LoadedAvatar => result.ok,
  });
}
