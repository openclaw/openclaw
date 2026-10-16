import path from "node:path";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { containsParentRefSegment } from "./policy.js";
import { skillSourceArchive } from "./workspace-skill-source.js";

/** Admission paths for the existing native Skills operations. */
export function readWorkspaceSkillsRequest(input: unknown) {
  const params = asOptionalRecord(input);
  if (
    typeof params?.workspaceDir !== "string" ||
    !path.posix.isAbsolute(params.workspaceDir) ||
    params.workspaceDir.includes("\0") ||
    containsParentRefSegment(params.workspaceDir) ||
    typeof params.request !== "string"
  ) {
    throw new Error("Invalid node Skills request");
  }
  const workspaceDir = path.posix.resolve(params.workspaceDir);
  const request = asOptionalRecord(JSON.parse(params.request));
  if (!request) {
    throw new Error("Skills request must be an object");
  }
  const paths: { path: string; kind: "read" | "write" }[] = [];
  const readPath = (value: unknown) => {
    if (typeof value !== "string" || !path.posix.isAbsolute(value) || value.includes("\0")) {
      throw new Error("Skill operation requires an absolute path");
    }
    if (containsParentRefSegment(value)) {
      throw new Error("Skill path contains parent segments");
    }
    return value;
  };
  const add = (value: unknown, kind: "read" | "write" = "read") => {
    paths.push({ path: path.posix.resolve(readPath(value)), kind });
  };
  const addSkill = (value: unknown, kind: "read" | "write") => {
    if (typeof value !== "string") {
      throw new Error("Skill operation requires a target");
    }
    // Native owners validate registry reference syntax. Its final component is
    // the only possible installed directory, including @owner/slug references.
    const slug = path.posix.basename(value.trim());
    if (!slug || slug === "." || slug === ".." || slug.includes("\\") || slug.includes("\0")) {
      throw new Error("Invalid Skill target");
    }
    const target = path.posix.join(workspaceDir, "skills", slug);
    add(target, kind);
    for (const file of [
      "SKILL.md",
      ".clawhub/origin.json",
      ".clawdhub/origin.json",
      ".openclaw/source-origin.json",
    ]) {
      add(path.posix.join(target, file), kind);
    }
  };
  switch (params.operation) {
    case "discovery":
    case "watch": {
      const plan = asOptionalRecord(request.sourcePlan);
      if (
        plan?.workspaceDir !== workspaceDir ||
        !Array.isArray(plan.roots) ||
        !Array.isArray(plan.pluginSkillRoots)
      ) {
        throw new Error("Skill sources do not match the configured workspace");
      }
      add(workspaceDir);
      for (const key of [
        "stateDir",
        "managedSkillsDir",
        "pluginSkillsDir",
        "bundledSkillsDir",
      ] as const) {
        if (plan[key]) {
          add(plan[key]);
        }
      }
      for (const root of [...plan.roots, ...plan.pluginSkillRoots]) {
        add(asOptionalRecord(root)?.dir);
      }
      if (plan.allowSymlinkTargets !== undefined) {
        if (!Array.isArray(plan.allowSymlinkTargets)) {
          throw new Error("Invalid Skill roots");
        }
        for (const target of plan.allowSymlinkTargets) {
          add(target);
        }
      }
      if (request.executionWorkspaceDir) {
        add(request.executionWorkspaceDir);
      }
      break;
    }
    case "readInstructions":
      add(request.filePath);
      break;
    case "resolveResource": {
      const selectionPath = readPath(request.path);
      // The native explicit loader selects SKILL.md, regardless of the supplied basename.
      add(path.posix.join(path.posix.dirname(selectionPath), "SKILL.md"));
      break;
    }
    case "readResources":
      add(asOptionalRecord(request.skill)?.baseDir);
      break;
    case "applyRoot":
      add(skillSourceArchive(workspaceDir, request.sourceArchive), "write");
      if (typeof request.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(request.slug)) {
        throw new Error("Invalid Skill install slug");
      }
      add(path.posix.join(workspaceDir, "skills"), "write");
      addSkill(request.slug, "write");
      break;
    case "removeSkill": {
      const plan = asOptionalRecord(request.plan);
      if (plan?.workspaceDir !== workspaceDir) {
        throw new Error("Skill removal plan does not match the workspace");
      }
      add(plan.targetDir, "write");
      addSkill(plan.slug, "write");
      add(path.posix.join(workspaceDir, "skills"), "write");
      for (const directory of [".clawhub", ".clawdhub"]) {
        add(path.posix.join(workspaceDir, directory, "lock.json"), "write");
      }
      break;
    }
    case "recordSource":
    case "clawhubRecordInstall":
    case "clawhubVerifyTarget":
    case "clawhubPreflight":
    case "clawhubReadLock":
    case "clawhubUpdateSlug":
    case "clawhubUpdateTarget":
    case "clawhubUpdateGuard":
    case "clawhubCheckInstall":
    case "clawhubReadFiles":
    case "clawhubPlanRemoval": {
      const writes =
        params.operation === "recordSource" || params.operation === "clawhubRecordInstall";
      const kind = writes ? "write" : "read";
      add(path.posix.join(workspaceDir, "skills"), kind);
      for (const directory of [".clawhub", ".clawdhub"]) {
        add(path.posix.join(workspaceDir, directory, "lock.json"), kind);
      }
      if (writes) {
        const slug = asOptionalRecord(request.origin)?.slug;
        if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
          throw new Error("Invalid Skill provenance slug");
        }
        addSkill(slug, "write");
      }
      const reference =
        request.slug ?? request.requestedSlug ?? asOptionalRecord(request.requested)?.slug;
      if (reference !== undefined) {
        addSkill(reference, kind);
      }
      if (request.skillDir) {
        const skillDir = readPath(request.skillDir);
        if (path.posix.dirname(skillDir) !== path.posix.join(workspaceDir, "skills")) {
          throw new Error("Skill target is outside the workspace");
        }
        addSkill(path.posix.basename(skillDir), kind);
      }
      break;
    }
    case "installDependencies":
      // The command grant admits execution of Gateway-approved native recipes.
      // A file read grant alone cannot enable this command.
      add(path.posix.join(workspaceDir, "skills"), "write");
      break;
    default:
      throw new Error("Unknown node Skills operation");
  }
  if (params.watch !== (params.operation === "watch")) {
    throw new Error("Invalid Skills subscription");
  }
  return {
    workspaceDir,
    request: params.request,
    operation: params.operation,
    watch: params.operation === "watch",
    paths,
  };
}
