import path from "node:path";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { containsParentRefSegment } from "./policy.js";

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
  const add = (value: unknown, kind: "read" | "write" = "read") => {
    if (typeof value !== "string" || !path.posix.isAbsolute(value) || value.includes("\0")) {
      throw new Error("Skill operation requires an absolute path");
    }
    if (containsParentRefSegment(value)) {
      throw new Error("Skill path contains parent segments");
    }
    paths.push({ path: path.posix.resolve(value), kind });
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
    case "readCompanion": {
      const skillFilePath = request.skillFilePath;
      const relativePath = request.relativePath;
      const sourceRootIdentity = asOptionalRecord(request.sourceRootIdentity);
      if (
        typeof skillFilePath !== "string" ||
        typeof relativePath !== "string" ||
        !relativePath ||
        path.posix.isAbsolute(relativePath) ||
        relativePath.includes("\0") ||
        containsParentRefSegment(relativePath) ||
        relativePath.split("/").some((segment) => !segment || segment === ".") ||
        typeof sourceRootIdentity?.realPath !== "string" ||
        !path.posix.isAbsolute(sourceRootIdentity.realPath) ||
        sourceRootIdentity.realPath.includes("\0") ||
        containsParentRefSegment(sourceRootIdentity.realPath) ||
        typeof sourceRootIdentity.dev !== "string" ||
        !/^[1-9]\d{0,19}$/u.test(sourceRootIdentity.dev) ||
        typeof sourceRootIdentity.ino !== "string" ||
        !/^[1-9]\d{0,19}$/u.test(sourceRootIdentity.ino)
      ) {
        throw new Error("Invalid Skill companion path");
      }
      add(skillFilePath);
      add(sourceRootIdentity.realPath);
      add(path.posix.join(path.posix.dirname(skillFilePath), relativePath));
      break;
    }
    case "resolveResource": {
      const selectionPath = request.path;
      if (
        typeof selectionPath !== "string" ||
        !path.posix.isAbsolute(selectionPath) ||
        selectionPath.includes("\0")
      ) {
        throw new Error("Skill operation requires an absolute path");
      }
      if (containsParentRefSegment(selectionPath)) {
        throw new Error("Skill path contains parent segments");
      }
      // The native explicit loader selects SKILL.md, regardless of the supplied basename.
      add(path.posix.join(path.posix.dirname(selectionPath), "SKILL.md"));
      break;
    }
    case "readResources":
      add(asOptionalRecord(request.skill)?.baseDir);
      break;
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
