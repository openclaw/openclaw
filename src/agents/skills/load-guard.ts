/**
 * Skill load-guard registration point.
 *
 * The skill-guard Extension calls `registerSkillLoadGuard()` to inject
 * verification logic.  Core code in `loadSkillEntries()` calls
 * `getSkillLoadGuard()` to obtain the registered guard instance.
 *
 * This file is the **only** coupling point between the Extension and the core.
 */

import type { Skill } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("skills/guard");

export type SkillLoadGuardVerdict = {
  /** Skill names that must be blocked from loading. */
  blocked: string[];
  /** Optional warnings (do not block, log only). */
  warnings?: Array<{ name: string; message: string }>;
};

export type SkillLoadGuard = {
  /** Synchronously evaluate a batch of skills and return the verdict. */
  evaluate(skills: Map<string, Skill>): SkillLoadGuardVerdict;
};

let _guard: SkillLoadGuard | null = null;

/** Called by the Extension to register a guard. Returns an unregister function. */
export function registerSkillLoadGuard(guard: SkillLoadGuard): () => void {
  _guard = guard;
  log.info("skill load guard registered");
  return () => {
    _guard = null;
    log.info("skill load guard unregistered");
  };
}

/** Called by core code to retrieve the currently registered guard (if any). */
export function getSkillLoadGuard(): SkillLoadGuard | null {
  return _guard;
}
