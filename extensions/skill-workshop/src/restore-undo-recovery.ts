import path from "node:path";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import { hasNodeErrorCode } from "openclaw/plugin-sdk/path-existence-runtime";
import {
  listVersions,
  nextSkillVersionId,
  pruneVersions,
  type MutationPaths,
} from "./skill-versions.js";
import { WorkshopWriteError } from "./workshop-write-error.js";

/** Put the claimed files back without overwriting anything that has since appeared at the live name. */
export async function recoverDetachedRestore(paths: MutationPaths, name: string, detached: string) {
  const workshop = await root(paths.root);
  const claimed = path.relative(paths.root, detached);
  try {
    await workshop.move(claimed, name, { overwrite: false });
  } catch (rollbackError) {
    // Rollback is compensation. Publishing a History version requires a still-live request.
    for (;;) {
      const id = await nextSkillVersionId(paths.versionsDir, "archive");
      try {
        await workshop.move(claimed, path.relative(paths.root, path.join(paths.versionsDir, id)), {
          overwrite: false,
          assertBeforeMutation: paths.assertLive,
        });
      } catch (cause) {
        if (
          hasNodeErrorCode(cause, "already-exists") &&
          (await listVersions(paths.versionsDir)).some((version) => version.id === id)
        ) {
          continue;
        }
        throw new WorkshopWriteError(
          `Undo stopped. The detached files are retained at ${claimed} in the Workshop skills directory.`,
          { cause },
        );
      }
      const saved = `Undo stopped. The detached files for "${name}" are saved as version ${id}. Open it in History.`;
      try {
        await pruneVersions(paths.versionsDir, paths.assertLive);
      } catch (cause) {
        throw new WorkshopWriteError(`${saved} History cleanup did not finish.`, { cause });
      }
      throw new WorkshopWriteError(saved, { cause: rollbackError });
    }
  }
}
