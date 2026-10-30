import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";

const MAX_REMEMBERED_SESSIONS = 512;
const shapes = new Map<
  string,
  Pick<SkillLibraryAuthoringCapability, "defaultTarget" | "multipleProfiles">
>();

/**
 * Keeps the skill_workshop definition stable across a session's CLI turns.
 *
 * Only human turns receive personal-library authority, so completion and other
 * internal turns would otherwise publish a different skill_workshop schema and
 * break the native prompt cache. Those turns reuse the session's last shape
 * with an expired grant: the definition matches and personal-library calls are
 * refused. Workshop calls through the workspace-default wrapper keep the
 * ordinary no-grant rule (unsandboxed runs only), so this definition neither
 * revokes nor widens workspace access.
 */
export function resolveStableCliSkillAuthoring(
  sessionKey: string | undefined,
  authoring: SkillLibraryAuthoringCapability | undefined,
): SkillLibraryAuthoringCapability | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return authoring;
  }
  if (authoring) {
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
  const shape = shapes.get(key);
  if (!shape) {
    return undefined;
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
}
