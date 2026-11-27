import type { InternalSessionEntry } from "../config/sessions/types.js";
import type {
  SkillLibraryAuthoringCapability,
  SkillLibraryAuthoringPresentation,
} from "../skills/library/authoring.js";
import { SkillLibraryError } from "../skills/skill-library-error.js";

const MAX_REMEMBERED_SESSIONS = 512;

type Session = Pick<
  InternalSessionEntry,
  "sessionId" | "lifecycleRevision" | "skillLibraryAuthoringPresentation"
>;

/**
 * Keeps the skill_library and skill_workshop definitions stable across a
 * session's native turns.
 *
 * Only human turns receive personal-library authority, so completion and other
 * internal turns would otherwise publish a different tool set and break the
 * native prompt cache. Those turns reuse the session's last shape with an
 * expired grant: the definitions match and personal-library calls are refused,
 * including calls that rely on a personal default target. Workspace calls keep
 * the ordinary no-grant rule (unsandboxed runs only), so this never widens
 * access. Expired grants do not replace the remembered human shape. Each
 * runtime keeps its own shapes because runtimes can adjust the human shape
 * before publishing it.
 */
export function createStableSkillAuthoring() {
  const shapes = new Map<string, SkillLibraryAuthoringPresentation>();
  return (
    sessionKey: string | undefined,
    authoring: SkillLibraryAuthoringCapability | undefined,
    session?: Session,
  ): SkillLibraryAuthoringCapability | undefined => {
    const id = sessionKey?.trim();
    if (!id) {
      return authoring;
    }
    const key = JSON.stringify([id, session?.sessionId, session?.lifecycleRevision]);
    if (authoring && !authoring.expired) {
      shapes.delete(key);
      shapes.set(key, {
        defaultTarget: authoring.defaultTarget,
        multipleProfiles: authoring.multipleProfiles,
      });
      if (shapes.size > MAX_REMEMBERED_SESSIONS) {
        shapes.delete(shapes.keys().next().value!);
      }
      return authoring;
    }
    // The session owns the last human presentation. Never revive a grant from it.
    const stored = session?.skillLibraryAuthoringPresentation;
    const shape =
      stored &&
      stored.sessionId === session.sessionId &&
      stored.lifecycleRevision === (session.lifecycleRevision ?? null)
        ? stored
        : shapes.get(key);
    if (!shape) {
      return authoring;
    }
    if (authoring?.expired) {
      return {
        ...authoring,
        defaultTarget: shape.defaultTarget,
        multipleProfiles: shape.multipleProfiles,
        assertWorkspaceCurrent: () => {
          throw new SkillLibraryError("AUTHORITY_EXPIRED", "Skill authoring authority expired.");
        },
      };
    }
    const expired = () =>
      new SkillLibraryError(
        "AUTHORITY_EXPIRED",
        "Skill authoring needs a fresh message from the person requesting the change.",
      );
    return {
      target: "personal",
      defaultTarget: shape.defaultTarget,
      multipleProfiles: shape.multipleProfiles,
      expired: true,
      bind: () => {},
      assertWorkspaceCurrent: (run) => {
        if (run?.sandboxed !== false) {
          throw new SkillLibraryError(
            "FORBIDDEN",
            "Workshop is unavailable in a sandboxed run without library-authoring authority.",
          );
        }
      },
      invoke: async () => {
        throw expired();
      },
    };
  };
}

/** The CLI runtime's own shapes; the embedded runtime keeps a separate instance. */
export const resolveStableCliSkillAuthoring = createStableSkillAuthoring();
