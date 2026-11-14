import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";
import { SkillLibraryError } from "../../skills/skill-library-error.js";

const MAX_REMEMBERED_SESSIONS = 512;
const shapes = new Map<
  string,
  Pick<SkillLibraryAuthoringCapability, "defaultTarget" | "multipleProfiles">
>();

function rememberShape(
  key: string,
  shape: Pick<SkillLibraryAuthoringCapability, "defaultTarget" | "multipleProfiles">,
) {
  shapes.delete(key);
  shapes.set(key, {
    defaultTarget: shape.defaultTarget,
    multipleProfiles: shape.multipleProfiles,
  });
  if (shapes.size > MAX_REMEMBERED_SESSIONS) {
    shapes.delete(shapes.keys().next().value!);
  }
}

function expiredAuthoring(): SkillLibraryError {
  return new SkillLibraryError(
    "AUTHORITY_EXPIRED",
    "Skill authoring needs a fresh message from the person requesting the change.",
  );
}

/** Unsandboxed workspace Workshop stays available; sandboxed and personal-library calls do not. */
function assertUnsandboxedWorkspace(run?: { sandboxed?: boolean }) {
  if (run?.sandboxed !== false) {
    throw new SkillLibraryError(
      "FORBIDDEN",
      "Workshop is unavailable in a sandboxed run without library-authoring authority.",
    );
  }
}

function internalAuthoring(
  shape: Pick<SkillLibraryAuthoringCapability, "defaultTarget" | "multipleProfiles">,
  turnRefusal?: string,
): SkillLibraryAuthoringCapability {
  return {
    target: "personal",
    defaultTarget: shape.defaultTarget,
    multipleProfiles: shape.multipleProfiles,
    ...(turnRefusal ? { turnRefusal } : {}),
    bind: () => {},
    assertWorkspaceCurrent: assertUnsandboxedWorkspace,
    invoke: async () => {
      throw expiredAuthoring();
    },
  };
}

/**
 * Keeps the skill_library and skill_workshop definitions stable across a
 * session's CLI turns.
 *
 * Only human turns receive personal-library authority, so completion and other
 * internal turns would otherwise publish a different tool set and break the
 * native prompt cache. Those turns reuse the session's last shape with an
 * expired grant: the definitions match and personal-library calls are refused.
 * A supplied turn refusal keeps that shape, but Workshop still follows the
 * ordinary no-grant rule (unsandboxed runs only). A live human grant is returned
 * unchanged.
 */
export function resolveStableCliSkillAuthoring(
  sessionKey: string | undefined,
  authoring: SkillLibraryAuthoringCapability | undefined,
): SkillLibraryAuthoringCapability | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return authoring;
  }
  if (authoring && !authoring.turnRefusal) {
    rememberShape(key, authoring);
    return authoring;
  }
  if (authoring) {
    rememberShape(key, authoring);
    return internalAuthoring(authoring, authoring.turnRefusal);
  }
  const shape = shapes.get(key);
  return shape ? internalAuthoring(shape) : undefined;
}
